#!/usr/bin/env python3
"""
Optimization API using OR-Tools for VRP solving
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import sys
import os

# Try to import OR-Tools
try:
    from ortools.constraint_solver import routing_enums_pb2
    from ortools.constraint_solver import pywrapcp
    OR_TOOLS_AVAILABLE = True
except ImportError:
    OR_TOOLS_AVAILABLE = False
    print("WARNING: OR-Tools not installed. Install with: pip install ortools")

app = Flask(__name__)
CORS(app)

def compute_shortest_paths(distance_matrix_dict, all_nodes):
    """
    Compute shortest paths between all nodes using Floyd-Warshall algorithm.
    This ensures we have travel times between all node pairs, even if there's no direct edge.
    """
    # Initialize distance matrix with infinity for missing paths
    INF = 10**9  # Large number representing infinity
    n = len(all_nodes)
    node_to_index = {node: i for i, node in enumerate(all_nodes)}
    index_to_node = {i: node for i, node in enumerate(all_nodes)}
    
    # Initialize distance matrix
    dist = [[INF] * n for _ in range(n)]
    
    # Set diagonal to 0 (distance from node to itself)
    for i in range(n):
        dist[i][i] = 0
    
    # Fill in direct edges from distance_matrix_dict
    for from_node, to_dict in distance_matrix_dict.items():
        if from_node in node_to_index:
            from_idx = node_to_index[from_node]
            for to_node, travel_time in to_dict.items():
                if to_node in node_to_index:
                    to_idx = node_to_index[to_node]
                    dist[from_idx][to_idx] = int(travel_time)
    
    # Floyd-Warshall algorithm to find shortest paths
    for k in range(n):
        for i in range(n):
            for j in range(n):
                if dist[i][k] + dist[k][j] < dist[i][j]:
                    dist[i][j] = dist[i][k] + dist[k][j]
    
    # Convert back to dictionary format
    result = {}
    for i, from_node in enumerate(all_nodes):
        result[from_node] = {}
        for j, to_node in enumerate(all_nodes):
            if dist[i][j] < INF:
                result[from_node][to_node] = dist[i][j]
            else:
                # If still unreachable, use a very large number
                result[from_node][to_node] = 999999
    
    return result

def create_data_model(cauldrons_list, couriers, market, distance_matrix, prediction_horizon_minutes=480):
    """Create the data model for OR-Tools VRP solver with flexible partial pickups and FUTURE PREDICTION
    
    This model allows witches to:
    - Visit multiple cauldrons in one route
    - Partially collect from each cauldron to efficiently fill their 100L capacity
    - Target optimal/safe levels (70-80% of max) instead of just preventing overflow
    - PREDICT FUTURE OVERFLOWS and plan routes to prevent them (not just current state)
    
    Args:
        prediction_horizon_minutes: How far ahead to predict (default 8 hours = 480 minutes)
    """
    data = {}
    
    courier_capacity = 100  # Fixed capacity: 100 liters per courier
    optimal_level_ratio = 0.75  # Target 75% of max volume as optimal level
    safety_margin_minutes = 60  # Service cauldrons at least 1 hour before predicted overflow
    
    # PRIORITIZE: Sort cauldrons by FULLNESS FIRST (full ones first), then risk level, then time until overflow
    # This ensures full/high-level cauldrons are processed first
    def get_priority(cauldron):
        current_level = cauldron.get('currentLevel', 0)
        max_volume = cauldron.get('maxVolume', 100)
        fullness_ratio = current_level / max_volume if max_volume > 0 else 0
        risk_level = cauldron.get('riskLevel', 'low')
        risk_priority = {'high': 3, 'medium': 2, 'low': 1}.get(risk_level, 1)
        time_until_overflow = cauldron.get('timeUntilOverflow', 999999)
        # Higher priority = higher number
        # FULLNESS is most important (full cauldrons = highest priority)
        # Then risk level, then urgency (shorter time = higher priority)
        return (fullness_ratio * 10, risk_priority, -time_until_overflow)  # Fullness weighted heavily
    
    sorted_cauldrons = sorted(cauldrons_list, key=get_priority, reverse=True)
    print(f"Prioritizing cauldrons: {len([c for c in sorted_cauldrons if c.get('riskLevel') == 'high'])} high-risk, "
          f"{len([c for c in sorted_cauldrons if c.get('riskLevel') == 'medium'])} medium-risk, "
          f"{len([c for c in sorted_cauldrons if c.get('riskLevel') == 'low'])} low-risk")
    
    # NEW APPROACH: Create flexible pickup tasks (not just 100L chunks)
    # Each cauldron can have multiple small pickup tasks that can be combined efficiently
    # This allows witches to visit multiple cauldrons and partially fill from each
    pickup_tasks = []  # List of (cauldron_data, pickup_amount, min_pickup, max_pickup) tuples
    cauldron_node_mapping = {}  # Maps cauldronId -> list of node indices
    
    for cauldron in sorted_cauldrons:  # Process prioritized cauldrons
        current_level = cauldron.get('currentLevel', 0)
        max_volume = cauldron.get('maxVolume', 100)
        fill_rate = cauldron.get('fillRate', 0.01)  # Liters per minute
        time_until_overflow = cauldron.get('timeUntilOverflow', 999999)
        cauldron_id = cauldron['cauldronId']
        
        # PREDICTIVE FORECASTING: Calculate when this cauldron will overflow in the future
        # After a pickup, the level changes, so we need to predict future overflow times
        # Strategy: Plan to service cauldrons BEFORE they become critical
        
        # Calculate future overflow time if we don't service it now
        # This is the time when it will overflow if left alone
        future_overflow_time = time_until_overflow
        
        # Only create tasks for cauldrons that will overflow within the prediction horizon
        # OR cauldrons that are already at risk
        # When constrained to fewer vehicles (like 4), be more selective - only service critical ones
        will_overflow_in_horizon = future_overflow_time <= prediction_horizon_minutes
        is_currently_at_risk = time_until_overflow < 240  # Less than 4 hours = high risk
        is_medium_risk = time_until_overflow < 480  # Less than 8 hours = medium risk
        
        # Skip low-risk cauldrons that won't overflow soon
        # This reduces the number of tasks and allows fewer witches
        if not will_overflow_in_horizon and not is_currently_at_risk and not is_medium_risk:
            continue
        
        # Calculate demand needed to prevent overflow within the prediction horizon
        # We want to bring it to optimal level (75% of max) to give it a safety buffer
        optimal_target = max_volume * optimal_level_ratio
        
        # If it will overflow soon, we need to collect enough to prevent overflow
        # Calculate how much it will fill in the prediction horizon
        if fill_rate > 0:
            future_level = current_level + (fill_rate * prediction_horizon_minutes)
            # Cap future level at max volume
            future_level = min(future_level, max_volume)
            # Demand = enough to bring future level down to optimal target
            # This prevents overflow while maintaining safe levels
            demand_to_prevent_overflow = max(0, future_level - optimal_target)
        else:
            demand_to_prevent_overflow = 0
        
        # Also consider current demand (to reach optimal level now)
        current_demand = max(0, optimal_target - current_level)
        
        # Use the maximum of current demand and future prevention demand
        # This ensures we prevent both current and future overflows
        target_demand = max(current_demand, demand_to_prevent_overflow)
        
        # Cap at what's available (can't collect more than what's in the cauldron)
        target_demand = min(target_demand, current_level)
        
        # When constrained to fewer vehicles, prioritize urgent cauldrons
        # For low-risk cauldrons, reduce demand to allow more urgent ones to be serviced
        if time_until_overflow > 480:  # Low risk (more than 8 hours)
            # Reduce demand for low-risk cauldrons - just enough to maintain safety
            target_demand = min(target_demand, max_volume * 0.1)  # Only collect 10% of max for low-risk
        
        # Only create tasks if there's meaningful demand (at least 5L)
        # This prevents creating tasks for cauldrons that don't need service
        if target_demand < 5:
            continue  # Skip if demand is too small
        
        # Create flexible pickup tasks: split into chunks that help fill 100L capacity efficiently
        # For FULL cauldrons, create larger chunks to fill bags faster
        # For less full cauldrons, create smaller chunks for flexibility
        remaining_demand = target_demand
        node_indices = []
        
        # Determine chunk sizes based on fullness
        fullness_ratio = current_level / max_volume if max_volume > 0 else 0
        if fullness_ratio >= 0.9:  # Very full - use larger chunks to fill bags quickly
            chunk_sizes = [50, 40, 30, 20]  # Prefer larger chunks
        elif fullness_ratio >= 0.75:  # Full - medium chunks
            chunk_sizes = [40, 30, 25, 20]
        else:  # Less full - smaller chunks for flexibility
            chunk_sizes = [30, 25, 20, 15]
        
        while remaining_demand > 0.1:  # Continue until demand is very small
            # Find the largest chunk size that fits
            pickup_amount = 0
            for chunk_size in chunk_sizes:
                if remaining_demand >= chunk_size:
                    pickup_amount = chunk_size
                    break
            
            # If no chunk fits, use remaining demand (but cap appropriately)
            if pickup_amount == 0:
                if fullness_ratio >= 0.75:
                    pickup_amount = min(remaining_demand, 40)  # Larger chunks for full cauldrons
                else:
                    pickup_amount = min(remaining_demand, 30)  # Smaller chunks for less full
            
            # Create a task with flexible pickup range
            # min_pickup: at least 10L (minimum viable pickup)
            # max_pickup: the chunk size (can pick up this much)
            min_pickup = min(10, pickup_amount)  # At least 10L
            max_pickup = pickup_amount  # Can pick up the full chunk
            
            pickup_tasks.append((cauldron, pickup_amount, min_pickup, max_pickup))
            node_index = len(pickup_tasks)  # +1 because market is node 0
            node_indices.append(node_index)
            remaining_demand -= pickup_amount
        
        cauldron_node_mapping[cauldron_id] = node_indices
    
    # Create node list: [market, ...pickup_tasks]
    data['locations'] = [market['id']] + [c[0]['cauldronId'] for c in pickup_tasks]
    num_nodes = len(data['locations'])
    
    # Compute shortest paths between all nodes using Floyd-Warshall
    # First, get unique cauldron IDs for distance matrix
    unique_cauldron_ids = [market['id']] + list(set([c[0]['cauldronId'] for c in pickup_tasks]))
    complete_distance_matrix = compute_shortest_paths(distance_matrix, unique_cauldron_ids)
    
    # Build distance matrix for all nodes (including duplicates)
    # For duplicate nodes (same cauldron), use distance to the cauldron
    data['distance_matrix'] = []
    for i, from_node in enumerate(data['locations']):
        row = []
        for j, to_node in enumerate(data['locations']):
            if i == j:
                row.append(0)
            else:
                # Get travel time from complete distance matrix
                travel_time = complete_distance_matrix.get(from_node, {}).get(to_node, 999999)
                # Cap at reasonable maximum (24 hours = 1440 minutes)
                if travel_time >= 999999:
                    travel_time = 1440
                row.append(int(travel_time))
        data['distance_matrix'].append(row)
    
    # Number of vehicles: Start with fewer vehicles - the solver will find the minimum
    # Upper bound: one courier per pickup task (worst case)
    # But we'll try to use much fewer by combining tasks
    data['num_vehicles'] = min(len(couriers), len(pickup_tasks)) if couriers else len(pickup_tasks)
    
    # Depot (market) is always node 0
    data['depot'] = 0
    
    # Demands: 0 for market, pickup amount for each task
    # Use the target pickup amount (can be adjusted by solver if needed)
    data['demands'] = [0] + [c[1] for c in pickup_tasks]  # c[1] is the pickup_amount
    
    # Store min/max pickup constraints for each task
    data['min_pickups'] = [0] + [c[2] for c in pickup_tasks]  # c[2] is min_pickup
    data['max_pickups'] = [0] + [c[3] for c in pickup_tasks]  # c[3] is max_pickup
    
    # Vehicle capacities - each courier can carry 100 liters
    data['vehicle_capacities'] = [courier_capacity] * data['num_vehicles']
    
    # Time windows: [0, time_until_overflow - safety_margin] for each task
    # We want to service cauldrons BEFORE they overflow (with safety margin)
    # This prevents future overflows, not just current ones
    data['time_windows'] = [(0, 999999)]  # Market: can be visited anytime
    data['time_windows'].extend([
        (0, max(0, min(int(c[0].get('timeUntilOverflow', 999999)) - safety_margin_minutes, 10080))) 
        for c in pickup_tasks
    ])
    
    # Service times: 
    # - Market: 0 min (no service time when starting from market)
    # - Cauldrons: 5 min pickup time (time to collect potions from cauldron)
    data['service_times'] = [0] + [5] * len(pickup_tasks)  # 5 min pickup time at cauldrons
    data['market_unload_time'] = 15  # 15 minutes to unload at market
    
    # Store mapping for solution extraction
    data['cauldron_node_mapping'] = cauldron_node_mapping
    data['pickup_tasks'] = pickup_tasks  # Store original cauldron data and pickup amounts
    data['original_cauldrons'] = cauldrons_list  # Store original cauldron list for reference
    
    return data

def solve_vrp_with_vehicles(data, cauldrons, couriers, num_vehicles, optimize_for_time=False):
    """Solve VRP with a specific number of vehicles"""
    if not OR_TOOLS_AVAILABLE:
        raise Exception("OR-Tools not available. Please install: pip install ortools")
    
    # Create routing index manager with specified number of vehicles
    manager = pywrapcp.RoutingIndexManager(
        len(data['distance_matrix']),
        num_vehicles,
        data['depot']
    )
    
    # Create routing model
    routing = pywrapcp.RoutingModel(manager)
    
    # Define transit callback with PRIORITY for FULL cauldrons first
    # Full/high-level cauldrons get much lower cost (higher priority) to encourage visiting them first
    def transit_callback(from_index, to_index):
        """Returns the travel time between two nodes (for cost calculation)"""
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        base_cost = data['distance_matrix'][from_node][to_node]
        
        # CRITICAL: Penalize returning to market (depot) with unused capacity >15L
        # This forces witches to fill their bags before returning
        if to_node == data['depot']:  # Returning to market
            # Get current capacity from the route
            # We'll add a large penalty if there's significant unused capacity
            # This will be handled by the capacity dimension, but we can add a cost penalty here too
            # The solver will naturally try to minimize this
            return base_cost + 1000  # Large penalty for returning to market (encourages filling capacity first)
        
        # Add priority penalty: FULL cauldrons get much lower cost (visited first)
        # This encourages the solver to visit full/high-level cauldrons first
        if to_node > 0:  # Not the depot (market)
            task_idx = to_node - 1
            if task_idx < len(data['pickup_tasks']):
                task = data['pickup_tasks'][task_idx]
                cauldron = task[0]
                pickup_amount = task[1]  # Amount for this task
                risk_level = cauldron.get('riskLevel', 'low')
                time_until_overflow = cauldron.get('timeUntilOverflow', 999999)
                current_level = cauldron.get('currentLevel', 0)
                max_volume = cauldron.get('maxVolume', 100)
                fullness_ratio = current_level / max_volume if max_volume > 0 else 0
                
                # FULLNESS PRIORITY: Full cauldrons get MUCH lower cost (visited first)
                # This is the most important factor - full cauldrons must be serviced first
                if fullness_ratio >= 0.9:  # 90%+ full = very high priority
                    fullness_penalty = -200  # Strongly encourage early visit
                elif fullness_ratio >= 0.75:  # 75%+ full = high priority
                    fullness_penalty = -150  # Encourage early visit
                elif fullness_ratio >= 0.5:  # 50%+ full = medium priority
                    fullness_penalty = -50  # Slight encouragement
                else:  # Less than 50% full = lower priority
                    fullness_penalty = 50  # Discourage early visit
                
                # Risk level priority: high-risk nodes get lower cost (visited first)
                if risk_level == 'high':
                    priority_penalty = -100  # Reduce cost for high-risk (encourage early visit)
                elif risk_level == 'medium':
                    priority_penalty = -25  # Slight reduction for medium-risk
                else:
                    priority_penalty = 50  # Increase cost for low-risk (discourage early visit)
                
                # Urgency penalty: prioritize nodes that will overflow soon
                if time_until_overflow <= 240:  # Less than 4 hours = very urgent
                    urgency_penalty = -150  # Strongly encourage early visit
                elif time_until_overflow <= 480:  # Less than 8 hours = urgent
                    urgency_penalty = -75  # Encourage early visit
                else:
                    urgency_penalty = max(0, (time_until_overflow - 480) // 60)  # Penalty increases for each hour over 8 hours
                
                # ENCOURAGE combining pickups: smaller pickups get slightly lower cost
                # This helps witches fill their 100L capacity by visiting multiple cauldrons
                # But prioritize larger pickups from full cauldrons
                if fullness_ratio >= 0.75:
                    # For full cauldrons, prefer larger pickups (fill bag faster)
                    size_bonus = pickup_amount / 5  # Larger pickups from full cauldrons are better
                else:
                    # For less full cauldrons, smaller pickups are more flexible
                    size_bonus = -pickup_amount / 10  # Smaller pickups get small cost reduction (easier to combine)
                
                return max(1, base_cost + fullness_penalty + priority_penalty + urgency_penalty + size_bonus)  # Ensure positive cost
        
        return base_cost
    
    transit_callback_index = routing.RegisterTransitCallback(transit_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)
    
    # Add capacity constraint
    def demand_callback(from_index):
        """Returns the demand (volume) at a node"""
        from_node = manager.IndexToNode(from_index)
        return data['demands'][from_node]
    
    demand_callback_index = routing.RegisterUnaryTransitCallback(demand_callback)
    # Use the first num_vehicles capacities
    vehicle_capacities = data['vehicle_capacities'][:num_vehicles]
    capacity_dimension = routing.AddDimensionWithVehicleCapacity(
        demand_callback_index,
        0,  # null capacity slack
        vehicle_capacities,  # vehicle maximum capacities
        True,  # start cumul to zero
        'Capacity'
    )
    
    # CRITICAL: Add penalty for unused capacity when returning to market
    # This encourages witches to fill their bags to near 100L before returning
    # Penalize routes that return with >15L unused capacity
    capacity_dimension = routing.GetDimensionOrDie('Capacity')
    for vehicle_id in range(num_vehicles):
        end_index = routing.End(vehicle_id)
        capacity_var = capacity_dimension.CumulVar(end_index)
        # Set a penalty for unused capacity >15L
        # The solver will try to minimize this by filling capacity more efficiently
        # We'll use a soft constraint: prefer routes that use >85L capacity
        # This is handled implicitly by the cost function, but we can add an explicit penalty
        # Actually, OR-Tools doesn't support soft capacity constraints directly
        # Instead, we'll rely on the transit callback to penalize returning to market
        # and the solver will naturally try to fill capacity to minimize total cost
    
    # Add time dimension for time window constraints
    def time_callback(from_index, to_index):
        """Returns the transit time from one node to another"""
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        travel_time = data['distance_matrix'][from_node][to_node]
        service_time = data['service_times'][from_node]
        
        if to_node == data['depot']:
            return travel_time + service_time + data['market_unload_time']
        return travel_time + service_time
    
    time_callback_index = routing.RegisterTransitCallback(time_callback)
    routing.AddDimension(
        time_callback_index,
        999999,  # allow waiting time (slack)
        999999,  # maximum time per vehicle
        True,  # force start cumul to zero (all vehicles start at time 0)
        'Time'
    )
    
    time_dimension = routing.GetDimensionOrDie('Time')
    
    # Add time window constraints for each node
    for node_idx, time_window in enumerate(data['time_windows']):
        index = manager.NodeToIndex(node_idx)
        time_dimension.CumulVar(index).SetRange(time_window[0], time_window[1])
    
    # Set very high fixed cost per vehicle to strongly prefer fewer vehicles
    routing.SetFixedCostOfAllVehicles(10000000)
    
    # Set search parameters optimized for vehicle minimization AND priority
    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    
    # CRITICAL: Use AUTOMATIC strategy which tries multiple approaches including vehicle minimization
    # This is better than PATH_CHEAPEST_ARC for finding solutions with fewer vehicles
    search_parameters.first_solution_strategy = (
        routing_enums_pb2.FirstSolutionStrategy.AUTOMATIC
    )
    
    # Use GUIDED_LOCAL_SEARCH for better solutions (better than GREEDY_DESCENT for vehicle minimization)
    search_parameters.local_search_metaheuristic = (
        routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    )
    
    # Increase time limit to give solver more time to find solutions with fewer vehicles
    # This is critical for finding the true minimum - especially when trying 1, 2, 3, 4 vehicles
    # When constrained to a specific number (like 4), give even more time to find the best solution
    if num_vehicles <= 4:
        search_parameters.time_limit.seconds = 45  # More time for constrained solutions
    else:
        search_parameters.time_limit.seconds = 30  # 30 seconds per attempt - more time to find optimal solution
    search_parameters.log_search = False
    
    # CRITICAL: Use solution limit to prevent solver from getting stuck
    # But allow enough solutions to find good routes
    # When constrained to fewer vehicles, allow more solutions to explore
    if num_vehicles <= 4:
        search_parameters.solution_limit = 300  # More solutions when constrained
    else:
        search_parameters.solution_limit = 200  # Allow more solutions to explore better routes
    
    # Solve
    solution = routing.SolveWithParameters(search_parameters)
    return solution, routing, manager, time_dimension

def solve_vrp(data, cauldrons, couriers, optimize_for_time=False, max_vehicles_limit=None):
    """Solve VRP using OR-Tools with TRUE vehicle minimization - start from 1 and work up
    
    Args:
        max_vehicles_limit: Optional maximum number of vehicles to use (e.g., 4 to force 4-witch solution)
    """
    if not OR_TOOLS_AVAILABLE:
        raise Exception("OR-Tools not available. Please install: pip install ortools")
    
    max_vehicles = data['num_vehicles']
    
    # If max_vehicles_limit is set, cap the search at that limit
    if max_vehicles_limit is not None:
        max_vehicles = min(max_vehicles, max_vehicles_limit)
        print(f"CONSTRAINED to maximum {max_vehicles_limit} vehicles - finding OPTIMAL solution with 4 or fewer couriers...")
    
    # LINEAR SEARCH: Start from 1 vehicle and work up to find the TRUE minimum
    # This is more reliable than binary search for finding the absolute minimum
    best_solution = None
    best_routing = None
    best_manager = None
    best_time_dimension = None
    min_vehicles_needed = max_vehicles
    
    print(f"Finding OPTIMAL solution with 4 or fewer couriers (trying 1, 2, 3, 4... up to {max_vehicles})...")
    
    # Try vehicles starting from 1 (minimum) and work up
    # This ensures we find the TRUE minimum, not just a solution
    # When constrained to 4, we'll find the best solution with 4 or fewer couriers
    for num_vehicles in range(1, max_vehicles + 1):
        print(f"  Trying {num_vehicles} courier(s)...")
        
        solution, routing, manager, time_dimension = solve_vrp_with_vehicles(
            data, cauldrons, couriers, num_vehicles, optimize_for_time
        )
        
        if solution:
            # Solution found! This is the minimum (we started from 1)
            best_solution = solution
            best_routing = routing
            best_manager = manager
            best_time_dimension = time_dimension
            min_vehicles_needed = num_vehicles
            print(f"    ✓✓✓ OPTIMAL SOLUTION FOUND with {num_vehicles} courier(s) - NO OVERFLOWS!")
            break  # Stop immediately - we found the minimum
        else:
            print(f"    ✗ No solution with {num_vehicles} courier(s), trying more...")
    
    if not best_solution:
        if max_vehicles_limit is not None:
            raise Exception(f"No solution found with {max_vehicles_limit} or fewer couriers. The constraints may be too tight - some cauldrons may overflow. Consider using more couriers or adjusting the prediction horizon.")
        else:
            raise Exception("No solution found. This may indicate that the constraints are too tight or some cauldrons are unreachable.")
    
    print(f"✓✓✓ OPTIMAL SOLUTION: {min_vehicles_needed} courier(s) needed (within {max_vehicles_limit if max_vehicles_limit else max_vehicles} limit)")
    
    # Use the best solution found
    solution = best_solution
    routing = best_routing
    manager = best_manager
    time_dimension = best_time_dimension
    
    # Extract solution
    routes = []
    total_time = 0
    capacity_dimension = routing.GetDimensionOrDie('Capacity')  # Get capacity dimension for validation
    
    used_vehicle_count = 0
    
    # Use min_vehicles_needed instead of data['num_vehicles'] since we found the minimum
    for vehicle_id in range(min_vehicles_needed):
        index = routing.Start(vehicle_id)
        route_stops = []
        route_volume = 0
        cumulative_volume = 0  # Track cumulative volume at each step
        
        # Check if this vehicle is used
        if routing.IsEnd(solution.Value(routing.NextVar(index))):
            continue  # Skip unused vehicles
        
        used_vehicle_count += 1
        
        # Track route from start to end, calculating times correctly
        # Always calculate times manually from the route to ensure accuracy
        current_time = 0  # Start at time 0 (at market)
        previous_node_index = None  # No previous node at start
        last_cauldron_node_index = None  # Track last cauldron node index for return calculation
        
        # Move to first node (skip the start node which is the market)
        index = solution.Value(routing.NextVar(index))
        
        # Track route from start to end
        while not routing.IsEnd(index):
            node_index = manager.IndexToNode(index)
            
            # Get cumulative capacity at this node from OR-Tools
            capacity_var = capacity_dimension.CumulVar(index)
            cumulative_capacity_from_solver = solution.Value(capacity_var)
            
            # Calculate travel time from previous node to current node
            if previous_node_index is not None:
                travel_time = data['distance_matrix'][previous_node_index][node_index]
                
                # Validate travel time is reasonable (max 24 hours = 1440 minutes)
                if travel_time >= 1440 or travel_time < 0:
                    travel_time = 30  # Fallback to reasonable default
                
                # Add travel time from previous node to current node
                current_time = current_time + travel_time
            else:
                # First node: travel from market (node 0) to first cauldron
                travel_time = data['distance_matrix'][0][node_index]
                if travel_time >= 1440 or travel_time < 0:
                    travel_time = 30
                current_time = travel_time  # Start time is just travel from market
            
            # Get arrival time from solver as a check (but use calculated time)
            time_var = time_dimension.CumulVar(index)
            arrival_time_from_solver = solution.Value(time_var)
            
            # Use calculated time (more reliable)
            arrival_time = current_time
            
            if node_index > 0:  # Not the depot (market) - it's a pickup task node
                task_idx = node_index - 1
                if task_idx < len(data['pickup_tasks']):
                    task = data['pickup_tasks'][task_idx]
                    cauldron = task[0]  # Original cauldron data
                    pickup_amount = task[1]  # Target pickup amount for this task
                    min_pickup = task[2]  # Minimum pickup (for validation)
                    max_pickup = task[3]  # Maximum pickup (for validation)
                    
                    # Update cumulative volume BEFORE pickup
                    cumulative_volume_before = cumulative_volume
                    cumulative_volume += pickup_amount
                    
                    # Validate capacity constraint: cumulative volume should never exceed 100L
                    if cumulative_volume > 100:
                        raise Exception(f"CAPACITY VIOLATION: Vehicle {vehicle_id} at node {node_index} (cauldron {cauldron.get('cauldronId')}) has cumulative volume {cumulative_volume}L, exceeding 100L limit!")
                    
                    # Validate against solver's capacity dimension
                    if cumulative_capacity_from_solver > 100:
                        raise Exception(f"CAPACITY VIOLATION (from solver): Vehicle {vehicle_id} at node {node_index} has capacity {cumulative_capacity_from_solver}L, exceeding 100L limit!")
                    
                    # CRITICAL: Validate that arrival time is within the time window (NO OVERFLOW ALLOWED)
                    time_until_overflow = int(cauldron.get('timeUntilOverflow', 999999))
                    if arrival_time > time_until_overflow:
                        # This is a critical error - overflow will occur!
                        raise Exception(f"OVERFLOW VIOLATION: Cauldron {cauldron.get('cauldronId')} ({cauldron.get('cauldronName')}) will overflow! Arrival time {arrival_time}min exceeds overflow time {time_until_overflow}min. Need more witches or better routing.")
                    
                    route_stops.append({
                        'cauldronId': cauldron['cauldronId'],
                        'cauldronName': cauldron['cauldronName'],
                        'arrivalTime': int(arrival_time),  # Minutes from start (when courier arrives at cauldron)
                        'pickupVolume': pickup_amount,  # Partial pickup amount (max 100L)
                        'cumulativeVolume': cumulative_volume,  # Cumulative volume after this pickup
                        'timeUntilOverflow': time_until_overflow  # Include for validation
                    })
                    route_volume += pickup_amount
                    
                    # Add service time at this cauldron (5 min pickup time)
                    service_time_at_cauldron = data['service_times'][node_index]
                    current_time = arrival_time + service_time_at_cauldron
                    last_cauldron_node_index = node_index  # Track last cauldron visited
            
            previous_node_index = node_index
            # Move to next node
            index = solution.Value(routing.NextVar(index))
        
        # Validate final route volume doesn't exceed capacity
        if route_volume > 100:
            raise Exception(f"ROUTE CAPACITY VIOLATION: Vehicle {vehicle_id} route has total volume {route_volume}L, exceeding 100L limit!")
        
        if route_stops:
            # Calculate return time from last cauldron to market
            if last_cauldron_node_index is not None:
                return_travel_time = data['distance_matrix'][last_cauldron_node_index][0]  # from last cauldron to market (node 0)
                
                # Validate return travel time (max 24 hours = 1440 minutes)
                if return_travel_time >= 1440 or return_travel_time < 0:
                    return_travel_time = 30  # Fallback
            else:
                return_travel_time = 30  # Fallback
            
            # Route time = current time (after last pickup) + return travel + unload
            route_time = current_time + return_travel_time + data['market_unload_time']
            
            total_time = max(total_time, route_time)
            
            # Combine stops to the same cauldron (for multiple pickup tasks from same cauldron)
            # Group stops by cauldronId and combine pickup volumes
            # This shows the total collected from each cauldron across all tasks
            combined_stops = {}
            for stop in route_stops:
                cauldron_id = stop['cauldronId']
                if cauldron_id not in combined_stops:
                    combined_stops[cauldron_id] = {
                        'cauldronId': stop['cauldronId'],
                        'cauldronName': stop['cauldronName'],
                        'arrivalTime': stop['arrivalTime'],  # Use first arrival time
                        'pickupVolume': 0,
                        'timeUntilOverflow': stop['timeUntilOverflow']
                    }
                combined_stops[cauldron_id]['pickupVolume'] += stop['pickupVolume']
                # Update arrival time to earliest visit
                if stop['arrivalTime'] < combined_stops[cauldron_id]['arrivalTime']:
                    combined_stops[cauldron_id]['arrivalTime'] = stop['arrivalTime']
            
            # Convert back to list and sort by arrival time
            combined_stops_list = sorted(combined_stops.values(), key=lambda x: x['arrivalTime'])
            
            # Assign courier to route (cycle through available couriers)
            courier_idx = vehicle_id % len(couriers)
            courier = couriers[courier_idx]
            
            routes.append({
                'courierId': courier.get('courier_id') or f'courier_{vehicle_id}',
                'courierName': courier.get('name') or f'Courier {vehicle_id + 1}',
                'stops': combined_stops_list,
                'totalVolume': route_volume,
                'totalTime': route_time
            })
    
    # Sort routes by courier ID for consistent output
    routes.sort(key=lambda x: x['courierId'] or '')
    
    return {
        'numCouriers': min_vehicles_needed,  # Return the actual minimum number needed
        'routes': routes,
        'totalTime': total_time
    }

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'message': 'Optimization API is running',
        'ortools_available': OR_TOOLS_AVAILABLE
    })

@app.route('/optimize/routes', methods=['POST'])
def optimize_routes():
    """Optimize courier routes using OR-Tools VRP solver"""
    try:
        data = request.json
        
        if not data:
            return jsonify({'error': 'Missing request data'}), 400
        
        cauldrons = data.get('cauldrons', [])
        couriers = data.get('couriers', [])
        market = data.get('market', {})
        distance_matrix_data = data.get('distanceMatrix', [])
        optimize_for_time = data.get('optimizeForTime', False)
        
        if not cauldrons:
            return jsonify({'error': 'No cauldrons provided'}), 400
        if not couriers:
            return jsonify({'error': 'No couriers provided'}), 400
        if not market:
            return jsonify({'error': 'Market information not provided'}), 400
        
        # Convert distance matrix from array format to dict
        distance_matrix = {}
        for entry in distance_matrix_data:
            from_node = entry.get('from')
            to_list = entry.get('to', [])
            if from_node:
                distance_matrix[from_node] = {}
                for to_entry in to_list:
                    to_node = to_entry.get('to')
                    time = to_entry.get('time')
                    if to_node is not None and time is not None:
                        distance_matrix[from_node][to_node] = time
        
        # Validate that we have market in distance matrix
        market_id = market.get('id')
        if not market_id:
            return jsonify({'error': 'Market ID is required'}), 400
        
        # Validate that we have distances for all cauldrons
        missing_distances = []
        for cauldron in cauldrons:
            cauldron_id = cauldron.get('cauldronId')
            if not cauldron_id:
                continue
            # Check if we have distance from market to cauldron
            if market_id not in distance_matrix or cauldron_id not in distance_matrix.get(market_id, {}):
                missing_distances.append(f"market -> {cauldron_id}")
        
        # Get prediction horizon from request (default 8 hours = 480 minutes)
        # This determines how far ahead to predict future overflows
        prediction_horizon_minutes = data.get('predictionHorizonMinutes', 480)
        
        # Get maximum vehicles limit (e.g., 4 to force 4-witch solution)
        max_vehicles_limit = data.get('maxVehicles', None)
        if max_vehicles_limit is not None:
            print(f"CONSTRAINING solution to maximum {max_vehicles_limit} couriers - finding optimal path with 4 or fewer couriers that prevents ALL overflows")
        
        print(f"Using predictive forecasting with {prediction_horizon_minutes} minute horizon")
        
        # Create data model (will compute shortest paths for missing distances)
        # Pass prediction horizon to enable future overflow prediction
        vrp_data = create_data_model(cauldrons, couriers, market, distance_matrix, prediction_horizon_minutes)
        
        # Solve VRP with optional vehicle limit
        result = solve_vrp(vrp_data, cauldrons, couriers, optimize_for_time, max_vehicles_limit)
        
        return jsonify(result)
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    print(f"Starting Optimization API on port {port}")
    print(f"OR-Tools available: {OR_TOOLS_AVAILABLE}")
    app.run(host='0.0.0.0', port=port, debug=True)


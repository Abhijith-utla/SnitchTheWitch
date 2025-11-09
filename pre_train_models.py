#!/usr/bin/env python3
"""
Pre-train Prophet models for all cauldrons
Run this script before starting the server to have models ready instantly
"""

import sys
import os
import json
import requests
import time
from datetime import datetime, timedelta

# Add current directory to path
sys.path.insert(0, os.path.dirname(__file__))

# Import functions from prophet_api (need to define them here or import)
import hashlib

MODELS_DIR = 'prophet_models'
os.makedirs(MODELS_DIR, exist_ok=True)

def create_data_hash(time_series: list) -> str:
    """Create a hash from time series data to identify unique datasets"""
    if not time_series:
        return ''
    first_ts = time_series[0]['timestamp']
    last_ts = time_series[-1]['timestamp']
    length = len(time_series)
    hash_str = f"{first_ts}-{last_ts}-{length}"
    return hashlib.md5(hash_str.encode()).hexdigest()

def get_model_path(cauldron_key: str, data_hash: str) -> str:
    """Generate a file path for a saved model"""
    safe_hash = hashlib.md5(data_hash.encode()).hexdigest()[:12]
    return os.path.join(MODELS_DIR, f'{cauldron_key}_{safe_hash}.pkl')

def load_model(cauldron_key: str, data_hash: str):
    """Load a saved Prophet model from disk"""
    import pickle
    model_path = get_model_path(cauldron_key, data_hash)
    if os.path.exists(model_path):
        try:
            with open(model_path, 'rb') as f:
                model = pickle.load(f)
            return model
        except Exception as e:
            return None
    return None

def save_model(model, cauldron_key: str, data_hash: str) -> str:
    """Save a trained Prophet model to disk"""
    import pickle
    model_path = get_model_path(cauldron_key, data_hash)
    with open(model_path, 'wb') as f:
        pickle.dump(model, f)
    return model_path

try:
    from prophet import Prophet
    import pandas as pd
    import requests
except ImportError as e:
    print("ERROR: Required libraries not installed.")
    print("Run: pip install -r requirements_prophet.txt")
    sys.exit(1)

# API endpoint (adjust if needed)
API_BASE_URL = os.getenv('API_BASE_URL', 'https://hackutd2025.eog.systems')

def fetch_historical_data(start_date=None, end_date=None):
    """Fetch historical data from the API"""
    try:
        url = f"{API_BASE_URL}/api/Data"
        params = {}
        if start_date:
            params['start_date'] = start_date
        if end_date:
            params['end_date'] = end_date
        
        print(f"Fetching historical data from {url}...")
        response = requests.get(url, params=params, timeout=60)
        response.raise_for_status()
        data = response.json()
        print(f"Fetched {len(data)} data points")
        return data
    except Exception as e:
        print(f"Error fetching data: {e}")
        return []

def fetch_cauldrons():
    """Fetch cauldron list from the API"""
    try:
        url = f"{API_BASE_URL}/api/Information/cauldrons"
        print(f"Fetching cauldrons from {url}...")
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        cauldrons = response.json()
        print(f"Found {len(cauldrons)} cauldrons")
        return cauldrons
    except Exception as e:
        print(f"Error fetching cauldrons: {e}")
        return []

def prepare_time_series(historical_data, cauldron_key):
    """Extract time series for a specific cauldron"""
    time_series = []
    for point in historical_data:
        value = point.get('cauldron_levels', {}).get(cauldron_key, 0)
        if value > 0:
            time_series.append({
                'timestamp': point['timestamp'],
                'value': float(value)
            })
    return time_series

def train_model_for_cauldron(cauldron_key, time_series):
    """Train a Prophet model for a specific cauldron"""
    if len(time_series) < 100:
        print(f"  ⚠️  Insufficient data for {cauldron_key} ({len(time_series)} points, need 100+)")
        return False
    
    # Create data hash
    data_hash = create_data_hash(time_series)
    
    # Check if model already exists
    existing_model = load_model(cauldron_key, data_hash)
    if existing_model:
        print(f"  ✓ Model already exists for {cauldron_key}")
        return True
    
    print(f"  🏋️  Training model for {cauldron_key} ({len(time_series)} data points)...")
    start_time = time.time()
    
    try:
        # Prepare DataFrame
        df_data = []
        for point in time_series:
            df_data.append({
                'ds': point['timestamp'],
                'y': float(point['value'])
            })
        
        df = pd.DataFrame(df_data)
        df['ds'] = pd.to_datetime(df['ds'])
        
        # Remove timezone if present
        if df['ds'].dt.tz is not None:
            df['ds'] = df['ds'].dt.tz_convert('UTC').dt.tz_localize(None)
        
        # Use last 7+ days for training (or 70% of data)
        min_training_points = max(1008, int(len(df) * 0.7))
        training_df = df.tail(min_training_points)
        
        # Initialize and train model
        model = Prophet(
            seasonality_mode='additive',
            changepoint_prior_scale=0.05,
            yearly_seasonality=False,
            weekly_seasonality=True,
            daily_seasonality=True,
            interval_width=0.80
        )
        
        model.fit(training_df)
        
        # Save model
        save_model(model, cauldron_key, data_hash)
        
        elapsed = time.time() - start_time
        print(f"  ✓ Model trained and saved for {cauldron_key} ({elapsed:.1f}s)")
        return True
        
    except Exception as e:
        print(f"  ✗ Error training model for {cauldron_key}: {e}")
        return False

def main():
    print("=" * 60)
    print("Prophet Model Pre-Training Script")
    print("=" * 60)
    print()
    
    # Ensure models directory exists
    os.makedirs(MODELS_DIR, exist_ok=True)
    
    # Fetch data
    print("Step 1: Fetching data from API...")
    historical_data = fetch_historical_data()
    if not historical_data:
        print("ERROR: No historical data available")
        sys.exit(1)
    
    cauldrons = fetch_cauldrons()
    if not cauldrons:
        print("ERROR: No cauldrons found")
        sys.exit(1)
    
    print()
    print("Step 2: Training models for each cauldron...")
    print()
    
    trained_count = 0
    skipped_count = 0
    failed_count = 0
    
    for cauldron in cauldrons:
        cauldron_id = cauldron.get('id', '')
        cauldron_name = cauldron.get('name', cauldron_id)
        
        # Extract cauldron key (e.g., "cauldron_001" from "cauldron_1")
        parts = cauldron_id.split('_')
        if len(parts) > 1:
            num = parts[-1].lstrip('0') or '0'
            cauldron_key = f"cauldron_{num.zfill(3)}"
        else:
            cauldron_key = cauldron_id
        
        print(f"Processing {cauldron_name} ({cauldron_key})...")
        
        # Prepare time series
        time_series = prepare_time_series(historical_data, cauldron_key)
        
        if len(time_series) < 100:
            print(f"  ⚠️  Skipping {cauldron_key} - insufficient data")
            skipped_count += 1
            continue
        
        # Train model
        if train_model_for_cauldron(cauldron_key, time_series):
            trained_count += 1
        else:
            failed_count += 1
        
        print()
    
    print("=" * 60)
    print("Pre-training Complete!")
    print("=" * 60)
    print(f"✓ Trained: {trained_count}")
    print(f"⚠️  Skipped: {skipped_count}")
    print(f"✗ Failed: {failed_count}")
    print()
    print(f"Models saved to: {os.path.abspath(MODELS_DIR)}")
    print()
    print("You can now start the server and predictions will be instant!")
    print("Run: python3 prophet_api.py")

if __name__ == '__main__':
    main()


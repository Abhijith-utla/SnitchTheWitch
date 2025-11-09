#!/usr/bin/env python3
"""
Prophet Forecasting API
Uses Facebook's Prophet library for time series forecasting
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import pandas as pd
import numpy as np
from datetime import datetime, timedelta
import json
import sys
import os
import pickle
import hashlib

# Try to import Prophet, with helpful error messages
try:
    from prophet import Prophet
except ImportError as e:
    print("ERROR: Prophet library not installed. Run: pip install prophet")
    sys.exit(1)

# Check if cmdstanpy is available (required for Prophet)
try:
    import cmdstanpy
    # Try to initialize Prophet to check if stan_backend is available
    test_model = Prophet()
    print("Prophet initialized successfully")
except AttributeError as e:
    if 'stan_backend' in str(e):
        print("ERROR: Prophet's Stan backend is not properly installed.")
        print("Please run the following commands:")
        print("  pip install cmdstanpy")
        print("  python -c 'import cmdstanpy; cmdstanpy.install_cmdstan()'")
        print("Or use the alternative: pip install prophet[stan]")
        sys.exit(1)
    else:
        raise
except Exception as e:
    print(f"Warning: Could not verify Prophet installation: {e}")
    print("Attempting to continue anyway...")

app = Flask(__name__)
CORS(app)  # Enable CORS for React frontend

# Directory to store trained models
MODELS_DIR = 'prophet_models'
os.makedirs(MODELS_DIR, exist_ok=True)

def get_model_path(cauldron_key: str, data_hash: str) -> str:
    """Generate a file path for a saved model"""
    safe_hash = hashlib.md5(data_hash.encode()).hexdigest()[:12]
    return os.path.join(MODELS_DIR, f'{cauldron_key}_{safe_hash}.pkl')

def save_model(model: Prophet, cauldron_key: str, data_hash: str) -> str:
    """Save a trained Prophet model to disk"""
    model_path = get_model_path(cauldron_key, data_hash)
    with open(model_path, 'wb') as f:
        pickle.dump(model, f)
    print(f"Saved model to {model_path}")
    return model_path

def load_model(cauldron_key: str, data_hash: str) -> Prophet | None:
    """Load a saved Prophet model from disk"""
    model_path = get_model_path(cauldron_key, data_hash)
    if os.path.exists(model_path):
        try:
            with open(model_path, 'rb') as f:
                model = pickle.load(f)
            print(f"Loaded model from {model_path}")
            return model
        except Exception as e:
            print(f"Error loading model from {model_path}: {e}")
            return None
    return None

def create_data_hash(time_series: list) -> str:
    """Create a hash from time series data to identify unique datasets"""
    if not time_series:
        return ''
    # Use first timestamp, last timestamp, and length as hash
    first_ts = time_series[0]['timestamp']
    last_ts = time_series[-1]['timestamp']
    length = len(time_series)
    hash_str = f"{first_ts}-{last_ts}-{length}"
    return hashlib.md5(hash_str.encode()).hexdigest()

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({'status': 'ok', 'message': 'Prophet API is running'})

@app.route('/forecast', methods=['POST'])
def forecast():
    """
    Forecast endpoint
    Expects JSON with:
    {
        "data": [
            {"timestamp": "2024-10-30T00:00:00", "value": 100.5},
            ...
        ],
        "periods": 144,  # Number of periods to forecast
        "freq": "10min"   # Frequency: '10min', '1H', '1D', etc.
    }
    
    Returns:
    {
        "forecast": [
            {"ds": "2024-11-12T00:10:00", "yhat": 105.2, "yhat_lower": 100.1, "yhat_upper": 110.3},
            ...
        ],
        "trend": [...],
        "seasonal": {...}
    }
    """
    try:
        data = request.json
        
        if not data or 'data' not in data:
            return jsonify({'error': 'Missing data field'}), 400
        
        # Prepare DataFrame in Prophet format
        df_data = []
        for point in data['data']:
            df_data.append({
                'ds': point['timestamp'],
                'y': float(point['value'])
            })
        
        df = pd.DataFrame(df_data)
        # Convert to datetime and remove timezone (Prophet doesn't support timezone-aware datetimes)
        df['ds'] = pd.to_datetime(df['ds'])
        # Remove timezone if present (Prophet requirement)
        # Convert timezone-aware to naive by converting to UTC first, then removing timezone
        if df['ds'].dt.tz is not None:
            df['ds'] = df['ds'].dt.tz_convert('UTC').dt.tz_localize(None)
        
        if len(df) < 100:
            return jsonify({'error': 'Insufficient data. Need at least 100 points.'}), 400
        
        # Create data hash for caching
        data_hash = create_data_hash(data['data'])
        cauldron_key = 'single_forecast'  # Use a generic key for single forecasts
        
        # Try to load existing model
        model = load_model(cauldron_key, data_hash)
        needs_training = model is None
        
        if needs_training:
            print(f"Training new model (data hash: {data_hash[:8]}...)")
            # Initialize Prophet model
            try:
                model = Prophet(
                    seasonality_mode='additive',
                    changepoint_prior_scale=0.05,
                    yearly_seasonality=False,
                    weekly_seasonality=True,
                    daily_seasonality=True,
                    interval_width=0.80  # 80% confidence interval
                )
            except Exception as e:
                error_msg = str(e)
                if 'stan_backend' in error_msg:
                    return jsonify({
                        'error': 'Prophet Stan backend not installed. Please run: pip install cmdstanpy && python -c "import cmdstanpy; cmdstanpy.install_cmdstan()"'
                    }), 500
                raise
            
            # Fit the model
            model.fit(df)
            
            # Save the trained model
            save_model(model, cauldron_key, data_hash)
            print(f"Model trained and saved")
        else:
            print(f"Using saved model (data hash: {data_hash[:8]}...)")
        
        # Create future dataframe
        periods = data.get('periods', 144)  # Default: 144 periods (24 hours at 10-min intervals)
        freq = data.get('freq', '10min')
        
        future = model.make_future_dataframe(periods=periods, freq=freq)
        
        # Make predictions
        forecast_df = model.predict(future)
        
        # Extract only future predictions (not historical fit)
        future_only = forecast_df.tail(periods)
        
        # Format response
        forecast_data = []
        for _, row in future_only.iterrows():
            forecast_data.append({
                'ds': row['ds'].isoformat(),
                'yhat': float(row['yhat']),
                'yhat_lower': float(row['yhat_lower']),
                'yhat_upper': float(row['yhat_upper']),
                'trend': float(row['trend']),
                'weekly': float(row.get('weekly', 0)),
                'daily': float(row.get('daily', 0))
            })
        
        # Get trend and seasonality components for visualization
        trend_data = [float(x) for x in forecast_df['trend'].tail(periods).values]
        weekly_data = [float(x) for x in forecast_df.get('weekly', pd.Series([0]*len(forecast_df))).tail(periods).values]
        daily_data = [float(x) for x in forecast_df.get('daily', pd.Series([0]*len(forecast_df))).tail(periods).values]
        
        return jsonify({
            'forecast': forecast_data,
            'trend': trend_data,
            'weekly_seasonal': weekly_data,
            'daily_seasonal': daily_data,
            'model_params': {
                'changepoint_prior_scale': 0.05,
                'seasonality_mode': 'additive',
                'interval_width': 0.80
            }
        })
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/forecast/batch', methods=['POST'])
def forecast_batch():
    """
    Batch forecast for multiple cauldrons
    Expects:
    {
        "cauldrons": {
            "cauldron_001": [
                {"timestamp": "...", "value": 100.5},
                ...
            ],
            ...
        },
        "periods": 144,
        "freq": "10min"
    }
    """
    try:
        data = request.json
        
        if not data or 'cauldrons' not in data:
            return jsonify({'error': 'Missing cauldrons field'}), 400
        
        results = {}
        periods = data.get('periods', 144)
        freq = data.get('freq', '10min')
        
        for cauldron_id, time_series in data['cauldrons'].items():
            if len(time_series) < 100:
                continue
            
            # Create data hash for this cauldron's time series
            data_hash = create_data_hash(time_series)
            
            # Try to load existing model
            model = load_model(cauldron_id, data_hash)
            needs_training = model is None
            
            if needs_training:
                print(f"Training new model for {cauldron_id} (data hash: {data_hash[:8]}...)")
                
                # Prepare DataFrame
                df_data = []
                for point in time_series:
                    df_data.append({
                        'ds': point['timestamp'],
                        'y': float(point['value'])
                    })
                
                df = pd.DataFrame(df_data)
                # Convert to datetime and remove timezone (Prophet doesn't support timezone-aware datetimes)
                df['ds'] = pd.to_datetime(df['ds'])
                # Remove timezone if present (Prophet requirement)
                # Convert timezone-aware to naive by converting to UTC first, then removing timezone
                if df['ds'].dt.tz is not None:
                    df['ds'] = df['ds'].dt.tz_convert('UTC').dt.tz_localize(None)
                
                # Initialize and fit model
                try:
                    model = Prophet(
                        seasonality_mode='additive',
                        changepoint_prior_scale=0.05,
                        yearly_seasonality=False,
                        weekly_seasonality=True,
                        daily_seasonality=True,
                        interval_width=0.80
                    )
                except Exception as e:
                    error_msg = str(e)
                    if 'stan_backend' in error_msg:
                        return jsonify({
                            'error': 'Prophet Stan backend not installed. Please run: pip install cmdstanpy && python -c "import cmdstanpy; cmdstanpy.install_cmdstan()"'
                        }), 500
                    raise
                
                # Train the model
                model.fit(df)
                
                # Save the trained model
                save_model(model, cauldron_id, data_hash)
                print(f"Model trained and saved for {cauldron_id}")
            else:
                print(f"Using saved model for {cauldron_id} (data hash: {data_hash[:8]}...)")
            
            # Create future dataframe and predict (works with both new and loaded models)
            # We need the last timestamp from the original data to create future dates
            last_timestamp = pd.to_datetime(time_series[-1]['timestamp'])
            if last_timestamp.tz is not None:
                last_timestamp = last_timestamp.tz_convert('UTC').tz_localize(None)
            
            # Create future dates starting from the end of training data
            if freq == '1min':
                # Start 1 minute after the last training data point
                future_dates = pd.date_range(start=last_timestamp + pd.Timedelta(minutes=1), periods=periods, freq='1min')
            elif freq == '10min':
                future_dates = pd.date_range(start=last_timestamp + pd.Timedelta(minutes=10), periods=periods, freq='10min')
            elif freq == '1H':
                future_dates = pd.date_range(start=last_timestamp + pd.Timedelta(hours=1), periods=periods, freq='1H')
            else:
                future_dates = pd.date_range(start=last_timestamp + pd.Timedelta(days=1), periods=periods, freq='1D')
            
            future_df = pd.DataFrame({'ds': future_dates})
            forecast_df = model.predict(future_df)
            
            # Extract predictions
            forecast_data = []
            for _, row in forecast_df.iterrows():
                forecast_data.append({
                    'ds': row['ds'].isoformat(),
                    'yhat': float(row['yhat']),
                    'yhat_lower': float(row['yhat_lower']),
                    'yhat_upper': float(row['yhat_upper'])
                })
            
            results[cauldron_id] = forecast_data
        
        return jsonify({'results': results})
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/models/clear', methods=['POST'])
def clear_models():
    """Clear all saved models"""
    try:
        count = 0
        for filename in os.listdir(MODELS_DIR):
            if filename.endswith('.pkl'):
                os.remove(os.path.join(MODELS_DIR, filename))
                count += 1
        return jsonify({'message': f'Cleared {count} saved models'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/models/list', methods=['GET'])
def list_models():
    """List all saved models"""
    try:
        models = []
        for filename in os.listdir(MODELS_DIR):
            if filename.endswith('.pkl'):
                filepath = os.path.join(MODELS_DIR, filename)
                size = os.path.getsize(filepath)
                models.append({
                    'filename': filename,
                    'size': size,
                    'size_mb': round(size / (1024 * 1024), 2)
                })
        return jsonify({'models': models, 'count': len(models)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    print("Starting Prophet API server...")
    print("Make sure Prophet is installed: pip install prophet")
    print(f"Models will be saved to: {os.path.abspath(MODELS_DIR)}")
    app.run(host='0.0.0.0', port=5000, debug=True)


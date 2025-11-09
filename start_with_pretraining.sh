#!/bin/bash
# Start Prophet API server with pre-training

echo "=========================================="
echo "Prophet API Server Startup"
echo "=========================================="
echo ""

# Check if models directory exists and has models
MODELS_DIR="prophet_models"
if [ ! -d "$MODELS_DIR" ] || [ -z "$(ls -A $MODELS_DIR/*.pkl 2>/dev/null)" ]; then
    echo "No pre-trained models found. Pre-training models..."
    echo ""
    python3 pre_train_models.py
    echo ""
    echo "Pre-training complete!"
    echo ""
else
    echo "Pre-trained models found. Skipping training."
    echo ""
fi

echo "Starting Prophet API server..."
echo ""
python3 prophet_api.py


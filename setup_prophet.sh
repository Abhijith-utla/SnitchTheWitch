#!/bin/bash
echo "Setting up Prophet with Stan backend..."
echo ""

# Install Python packages
echo "Step 1: Installing Python packages..."
pip install -r requirements_prophet.txt

# Install CmdStan (required for Prophet)
echo ""
echo "Step 2: Installing CmdStan (this may take a few minutes)..."
python3 -c "import cmdstanpy; cmdstanpy.install_cmdstan()"

echo ""
echo "Setup complete! You can now start the Prophet API server with:"
echo "  python3 prophet_api.py"


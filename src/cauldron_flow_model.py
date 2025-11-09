"""
Random forest regression pipeline for predicting drop counts and deriving cauldron flow rates.

This module assumes the upstream data ingestion step delivers a pandas DataFrame with
feature columns describing the state of each cauldron (temperatures, pressures, etc.)
along with historical measurements of the drop count emitted over a known duration.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple
import warnings

import joblib
import numpy as np
import pandas as pd
import requests
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

DEFAULT_TARGET_COLUMN = "fill_rate_l_per_min"
DEFAULT_DURATION_COLUMN = "duration_seconds"
API_BASE_URL = "https://hackutd2025.eog.systems/api"


def _ensure_datetime(value: str | datetime) -> datetime:
    """Convert ISO8601 strings to timezone-aware datetime objects."""
    if isinstance(value, datetime):
        dt = value
    else:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


class CauldronDataClient:
    """
    Lightweight REST client for the HackUTD cauldron data API.
    """

    def __init__(
        self,
        base_url: str = API_BASE_URL,
        timeout: float = 30.0,
        session: Optional[requests.Session] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = session or requests.Session()

    def fetch_metadata(self) -> Dict[str, object]:
        """Retrieve available date range and sampling interval metadata."""
        resp = self.session.get(
            f"{self.base_url}/Data/metadata",
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()

    def fetch_data(
        self,
        start: Optional[datetime] = None,
        end: Optional[datetime] = None,
    ) -> List[Dict[str, object]]:
        """Fetch historical cauldron level snapshots for an interval."""
        params: Dict[str, int] = {}
        if start is not None:
            params["start_date"] = int(start.timestamp())
        if end is not None:
            params["end_date"] = int(end.timestamp())

        resp = self.session.get(
            f"{self.base_url}/Data",
            params=params or None,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()

    def load_historical_dataframe(
        self,
        start: Optional[datetime] = None,
        end: Optional[datetime] = None,
    ) -> Tuple[pd.DataFrame, Dict[str, object]]:
        """
        Download historical data and return a melted DataFrame.

        Parameters
        ----------
        start, end:
            Optional timezone-aware datetimes. If omitted, defaults to the range
            provided by the metadata.
        """
        metadata = self.fetch_metadata()
        meta_start = _ensure_datetime(metadata["start_date"])
        meta_end = _ensure_datetime(metadata["end_date"])

        start = _ensure_datetime(start) if start is not None else meta_start
        end = _ensure_datetime(end) if end is not None else meta_end

        if start >= end:
            raise ValueError("Start datetime must be before end datetime.")

        raw_payload = self.fetch_data(start=start, end=end)
        history_df = melt_historical_records(raw_payload)
        return history_df, metadata

    def fetch_cauldrons(self) -> List[Dict[str, object]]:
        """Retrieve cauldron metadata including max volumes."""
        resp = self.session.get(
            f"{self.base_url}/Information/cauldrons",
            timeout=self.timeout,
        )
        resp.raise_for_status()
        data = resp.json()
        return data if isinstance(data, list) else []

    def load_recent_dataframe(
        self,
        minutes: int = 120,
    ) -> Tuple[pd.DataFrame, Dict[str, object]]:
        """
        Convenience wrapper to pull only the most recent window of data.

        Parameters
        ----------
        minutes:
            Window size (in minutes) to request relative to the latest timestamp
            provided by the metadata endpoint.
        """
        metadata = self.fetch_metadata()
        meta_end = _ensure_datetime(metadata["end_date"])
        start = meta_end - timedelta(minutes=minutes)
        history_df, _ = self.load_historical_dataframe(start=start, end=meta_end)
        return history_df, metadata


def melt_historical_records(payload: List[Dict[str, object]]) -> pd.DataFrame:
    """
    Transform the API payload into a long-form DataFrame.

    Returns columns: timestamp (UTC datetime64), cauldron_id (str), level (float).
    """
    rows: List[Dict[str, object]] = []
    for entry in payload:
        timestamp = _ensure_datetime(entry["timestamp"])
        cauldron_levels = entry.get("cauldron_levels") or {}
        for cauldron_id, level in cauldron_levels.items():
            rows.append(
                {
                    "timestamp": pd.Timestamp(timestamp),
                    "cauldron_id": str(cauldron_id),
                    "level": float(level),
                }
            )
    if not rows:
        return pd.DataFrame(columns=["timestamp", "cauldron_id", "level"])

    df = pd.DataFrame(rows)
    df.sort_values(["cauldron_id", "timestamp"], inplace=True)
    df.reset_index(drop=True, inplace=True)
    return df


def prepare_training_dataset(
    history_df: pd.DataFrame,
    interval_minutes: float,
    rolling_window: int = 5,
) -> pd.DataFrame:
    """
    Engineer features and targets for the RandomForestRegressor.

    Parameters
    ----------
    history_df:
        Output from melt_historical_records.
    interval_minutes:
        Sampling interval reported by the API metadata.
    rolling_window:
        Window size for rolling statistics per cauldron.
    """
    if history_df.empty:
        raise ValueError("Historical dataframe is empty; cannot train model.")

    df = history_df.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df[DEFAULT_DURATION_COLUMN] = float(interval_minutes) * 60.0

    df["prev_level"] = df.groupby("cauldron_id")["level"].shift(1)
    df.dropna(subset=["prev_level"], inplace=True)

    df["level_delta"] = df["level"] - df["prev_level"]
    df["fill_amount"] = df["level_delta"].clip(lower=0.0)
    df["drop_amount"] = (-df["level_delta"]).clip(lower=0.0)
    df[DEFAULT_TARGET_COLUMN] = df["fill_amount"] / float(interval_minutes)

    df["rolling_fill_amount"] = (
        df.groupby("cauldron_id")["fill_amount"]
        .transform(lambda s: s.rolling(rolling_window, min_periods=1).mean())
    )
    df["rolling_fill_rate"] = df["rolling_fill_amount"] / float(interval_minutes)
    df["rolling_drop_amount"] = (
        df.groupby("cauldron_id")["drop_amount"]
        .transform(lambda s: s.rolling(rolling_window, min_periods=1).mean())
    )

    df["hour_of_day"] = df["timestamp"].dt.hour + df["timestamp"].dt.minute / 60.0
    df["hour_sin"] = np.sin(2 * np.pi * df["hour_of_day"] / 24)
    df["hour_cos"] = np.cos(2 * np.pi * df["hour_of_day"] / 24)

    df["day_of_week"] = df["timestamp"].dt.dayofweek
    df["dow_sin"] = np.sin(2 * np.pi * df["day_of_week"] / 7)
    df["dow_cos"] = np.cos(2 * np.pi * df["day_of_week"] / 7)

    feature_columns = [
        "cauldron_id",
        "level",
        "prev_level",
        "level_delta",
        "fill_amount",
        "drop_amount",
        "rolling_fill_rate",
        "rolling_fill_amount",
        "rolling_drop_amount",
        "hour_sin",
        "hour_cos",
        "dow_sin",
        "dow_cos",
        DEFAULT_DURATION_COLUMN,
    ]
    df = df[["timestamp"] + feature_columns + [DEFAULT_TARGET_COLUMN]]
    df.set_index("timestamp", inplace=True)
    return df


@dataclass
class CauldronFlowModelConfig:
    """
    Configuration bundle for the cauldron flow model.

    Parameters
    ----------
    feature_columns:
        Subset of DataFrame columns to treat as model features. If omitted, every column
        except the target and duration columns is used.
    categorical_features:
        Names of categorical columns (subset of feature_columns) for one-hot encoding.
    numerical_features:
        Names of numeric columns (subset of feature_columns) for scaling.
    target_column:
        Column containing the observed drop count.
    duration_column:
        Column containing the measurement duration in seconds. Used to derive flow rate.
    test_size:
        Proportion of the dataset to hold out for model evaluation.
    random_state:
        Random seed to make results reproducible.
    n_estimators:
        Number of trees in the random forest.
    max_depth:
        Optional maximum tree depth for the forest.
    """

    feature_columns: Optional[List[str]] = None
    categorical_features: Optional[List[str]] = None
    numerical_features: Optional[List[str]] = None
    target_column: str = DEFAULT_TARGET_COLUMN
    duration_column: str = DEFAULT_DURATION_COLUMN
    test_size: float = 0.2
    random_state: int = 42
    n_estimators: int = 300
    max_depth: Optional[int] = None

    def resolve_features(self, df: pd.DataFrame) -> tuple[List[str], List[str], List[str]]:
        """Infer feature column groupings when not explicitly configured."""
        feature_cols = (
            self.feature_columns
            if self.feature_columns is not None
            else [
                col
                for col in df.columns
                if col not in {self.target_column, self.duration_column}
            ]
        )
        if not feature_cols:
            raise ValueError("No feature columns provided or inferred.")

        if self.categorical_features is not None:
            cat_features = self.categorical_features
        else:
            cat_features = [
                col
                for col in feature_cols
                if pd.api.types.is_object_dtype(df[col]) or pd.api.types.is_categorical_dtype(df[col])
            ]

        if self.numerical_features is not None:
            num_features = self.numerical_features
        else:
            num_features = [
                col
                for col in feature_cols
                if col not in cat_features
                and pd.api.types.is_numeric_dtype(df[col])
            ]

        missing_features = set(feature_cols) - set(cat_features) - set(num_features)
        if missing_features:
            raise ValueError(
                f"Feature columns {missing_features} were not classified as categorical or numerical."
            )

        return feature_cols, cat_features, num_features


class CauldronFlowModel:
    """
    Random forest regression facade to predict drop counts and compute flow rates.

    Usage
    -----
    >>> model = CauldronFlowModel()
    >>> metrics = model.fit(training_df)
    >>> predictions = model.predict_flow_rate(new_df)
    """

    def __init__(self, config: Optional[CauldronFlowModelConfig] = None) -> None:
        self.config = config or CauldronFlowModelConfig()
        self.pipeline: Optional[Pipeline] = None
        self._feature_columns: Optional[List[str]] = None

    def _build_pipeline(
        self,
        categorical_features: Iterable[str],
        numerical_features: Iterable[str],
    ) -> Pipeline:
        """Create the preprocessing + model pipeline."""
        transformers = []
        if categorical_features:
            transformers.append(
                (
                    "categorical",
                    OneHotEncoder(handle_unknown="ignore"),
                    list(categorical_features),
                )
            )
        if numerical_features:
            transformers.append(
                (
                    "numerical",
                    StandardScaler(),
                    list(numerical_features),
                )
            )

        preprocessor = ColumnTransformer(transformers=transformers)

        model = RandomForestRegressor(
            n_estimators=self.config.n_estimators,
            max_depth=self.config.max_depth,
            random_state=self.config.random_state,
            n_jobs=-1,
        )

        return Pipeline(
            steps=[
                ("preprocessor", preprocessor),
                ("regressor", model),
            ]
        )

    def fit(self, df: pd.DataFrame) -> dict[str, float]:
        """
        Train the pipeline and report evaluation metrics.

        Returns
        -------
        dict[str, float]
            Contains R² and MAE on the hold-out validation set.
        """
        train_df = df[df[self.config.target_column] > 0].copy()
        if train_df.empty:
            raise ValueError(
                "Training data contains no positive fill-rate observations. "
                "Ensure the history dataframe includes periods where levels increased."
            )

        feature_cols, cat_features, num_features = self.config.resolve_features(train_df)

        X = train_df[feature_cols]
        y = train_df[self.config.target_column]

        X_train, X_val, y_train, y_val = train_test_split(
            X,
            y,
            test_size=self.config.test_size,
            random_state=self.config.random_state,
        )

        self.pipeline = self._build_pipeline(cat_features, num_features)
        self._feature_columns = feature_cols
        self.pipeline.fit(X_train, y_train)

        y_pred = self.pipeline.predict(X_val)
        metrics = {
            "r2": float(r2_score(y_val, y_pred)),
            "mae": float(mean_absolute_error(y_val, y_pred)),
        }
        return metrics

    def predict_fill_rate(self, df: pd.DataFrame) -> np.ndarray:
        """Predict fill rates (liters per minute) given cauldron state observations."""
        if self.pipeline is None:
            raise RuntimeError("Model has not been fitted. Call fit() first.")
        if self._feature_columns is None:
            raise RuntimeError("Feature columns are unknown; fit the model first.")
        missing = set(self._feature_columns) - set(df.columns)
        if missing:
            raise ValueError(f"Missing required feature columns for prediction: {missing}")
        return self.pipeline.predict(df[self._feature_columns])

    # Backwards compatibility shim
    def predict_drop_count(self, df: pd.DataFrame) -> np.ndarray:
        warnings.warn(
            "predict_drop_count is deprecated; use predict_fill_rate instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        return self.predict_fill_rate(df)

    def predict_flow_rate(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Predict drop counts and infer flow rates per cauldron observation.

        Returns
        -------
        pd.DataFrame
            Original feature columns plus:
            - predicted_drop_count
            - flow_rate_drops_per_second
        """
        if self.pipeline is None:
            raise RuntimeError("Model has not been fitted. Call fit() first.")

        if self._feature_columns is None:
            raise RuntimeError("Feature columns are unknown; fit the model first.")
        missing = set(self._feature_columns) - set(df.columns)
        if missing:
            raise ValueError(f"Missing required feature columns for prediction: {missing}")

        predictions = self.predict_fill_rate(df)
        flow_rate_per_min = predictions
        flow_rate_per_sec = flow_rate_per_min / 60.0
        output = df.copy()
        output["predicted_fill_rate_l_per_min"] = flow_rate_per_min
        output["predicted_fill_rate_l_per_sec"] = flow_rate_per_sec
        return output

    def save(self, path: Path | str) -> None:
        """Persist the trained pipeline to disk."""
        if self.pipeline is None:
            raise RuntimeError("Nothing to save: model has not been trained yet.")
        joblib.dump(
            {
                "pipeline": self.pipeline,
                "config": self.config,
                "feature_columns": self._feature_columns,
            },
            Path(path),
        )

    @classmethod
    def load(cls, path: Path | str) -> "CauldronFlowModel":
        """Reload a previously trained model from disk."""
        artifact = joblib.load(Path(path))
        model = cls(config=artifact["config"])
        model.pipeline = artifact["pipeline"]
        model._feature_columns = artifact.get("feature_columns")
        return model


def example_usage() -> None:
    """
    Standalone example showing how to fetch real API data, train the model,
    and generate flow-rate predictions for the latest observation per cauldron.
    """
    client = CauldronDataClient()
    raw_history, metadata = client.load_recent_dataframe(minutes=240)
    interval_minutes = float(metadata.get("interval_minutes") or 1)
    training_df = prepare_training_dataset(raw_history, interval_minutes=interval_minutes)

    model = CauldronFlowModel()
    metrics = model.fit(training_df)
    print("Validation metrics:", metrics)

    latest_window = (
        training_df.reset_index()
        .sort_values("timestamp")
        .groupby("cauldron_id")
        .tail(1)
    )
    flow_predictions = model.predict_flow_rate(latest_window)
    print(
        flow_predictions[
            [
                "timestamp",
                "cauldron_id",
                "predicted_fill_rate_l_per_min",
                "predicted_fill_rate_l_per_sec",
            ]
        ]
    )


if __name__ == "__main__":
    example_usage()


"""Settings from environment / .env (see infra/.env.example). No secrets in code."""
from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(ROOT / ".env", ROOT / "infra" / ".env"), extra="ignore")

    database_url: str = "postgresql+psycopg://carbonkhata:carbonkhata@localhost:5432/carbonkhata"
    jwt_secret: str = "dev-only-change-me"
    jwt_ttl_minutes: int = 720
    otp_dev_echo: bool = True            # dev: return the OTP in the response and print it to the console
    mqtt_host: str = "localhost"
    mqtt_port: int = 1883
    mqtt_enabled: bool = True
    device_keys: str = "sim-vbw:dev-device-key,sim-afl:dev-device-key,sim-cluster:dev-device-key,sim-market:dev-device-key"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    storage_dir: str = str(ROOT / "api" / "storage")
    open_meteo_enabled: bool = True
    electricitymaps_api_key: str = ""
    smart_meter_api_url: str = ""        # head-end system (HES) REST endpoint; empty = use the MQTT push feed only
    smart_meter_api_key: str = ""
    iex_api_url: str = ""                # licensed market-data feed; empty = mock replay of the 96-block shape
    iex_api_key: str = ""
    kyb_api_url: str = ""                # GSP / KYC vendor; empty = local format checks (mock)
    kyb_api_key: str = ""
    smtp_url: str = ""                   # OTP e-mail; empty = console
    scheduler_enabled: bool = True
    demo_reset_enabled: bool = True      # allow the simulator's "reset all demo data" (admin/device only)


settings = Settings()

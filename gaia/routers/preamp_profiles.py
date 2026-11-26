"""GAIA-owned preamp calibration profile endpoints (writes to `.gaia/profiles/preamp_profiles/`)."""

from __future__ import annotations

from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core.processors.preamp_profiles import (
    calibrate_preamp_from_wav,
    list_preamp_profiles,
    preamp_profiles_directory,
)

router = APIRouter(prefix="/profiles/preamp", tags=["Profiles"])


class PreampCalibrateRequest(BaseModel):
    wav_path: str
    profile_id: str
    label: Optional[str] = None
    device_family: str = "custom"
    default_topology: str = "mono_or_dual_mono"
    calibrated_gain_setting: Optional[float] = None
    description: str = ""


@router.get("")
def get_preamp_profiles():
    return {
        "profiles_dir": str(preamp_profiles_directory()),
        "profiles": [p.to_public_dict() for p in list_preamp_profiles()],
    }


@router.post("/calibrate")
def calibrate_preamp_profile(payload: PreampCalibrateRequest):
    try:
        return calibrate_preamp_from_wav(
            payload.wav_path,
            profile_id=payload.profile_id,
            label=payload.label,
            device_family=payload.device_family,
            default_topology=payload.default_topology,
            calibrated_gain_setting=payload.calibrated_gain_setting,
            description=payload.description,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

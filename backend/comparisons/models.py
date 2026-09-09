from typing import Literal
from datetime import date
from pydantic import BaseModel, ConfigDict, Field, model_validator
from .statistics import finite, METRICS


class TimeInterval(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    start_sec: float = Field(ge=0, allow_inf_nan=False)
    end_sec: float = Field(gt=0, allow_inf_nan=False)

    @model_validator(mode="after")
    def ordered(self):
        if self.end_sec <= self.start_sec:
            raise ValueError("El intervalo debe tener duración positiva.")
        return self


class Exclusion(TimeInterval):
    reason: str = Field(min_length=3, max_length=1000)


class AdvancedOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    gps_geometry: bool = False
    lag_max_seconds: int = Field(default=30, ge=1, le=120)
    intensity_bounds: list[float] = Field(default_factory=lambda: [110, 140, 170], max_length=8)
    transient_min_change_bpm:float=Field(default=10,ge=3,le=80,allow_inf_nan=False)
    transient_dwell_seconds:int=Field(default=3,ge=1,le=10)

    @model_validator(mode="after")
    def ordered_bounds(self):
        if any(not finite(v) or v <= 0 or v >= 300 for v in self.intensity_bounds) or self.intensity_bounds != sorted(set(self.intensity_bounds)):
            raise ValueError("Los límites de intensidad deben ser crecientes, únicos y estar entre 0 y 300 bpm.")
        return self


class UncertaintyOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    repetitions: int = Field(default=1000, ge=200, le=5000)
    seed: int = Field(default=2026, ge=0, le=4294967295)
    confidence: float = Field(default=0.95, ge=0.8, le=0.99, allow_inf_nan=False)


class SessionFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    device_ids: list[str] = Field(default_factory=list, max_length=20)
    sport_type: str | None = Field(default=None, max_length=50)
    session_difficulty: str | None = Field(default=None, max_length=50)
    date_from: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    date_to: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    firmware: str | None = Field(default=None, max_length=160)
    participant_id: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def valid_dates(self):
        for value in (self.date_from,self.date_to):
            if value:date.fromisoformat(value)
        if self.date_from and self.date_to and self.date_to<self.date_from:
            raise ValueError("La fecha final no puede ser anterior a la inicial.")
        return self


class Visualization(BaseModel):
    model_config = ConfigDict(extra="forbid")
    hidden: list[str] = Field(default_factory=list, max_length=10)
    tab: Literal["hr", "gps"] = "hr"
    error_band: Literal[0, 3, 5, 10] = 0
    benchmark_metric: str = "mae"
    layout: Literal["OVERLAY", "SMALL_MULTIPLES"] = "OVERLAY"
    diagnostic: Literal["scatter", "bland_altman", "ecdf"] = "scatter"
    error_view:Literal["SIGNED","ABSOLUTE"]="SIGNED"

    @model_validator(mode="after")
    def validate_metric(self):
        if self.benchmark_metric not in METRICS:
            raise ValueError("Métrica de visualización desconocida.")
        return self


class Selection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(default="Comparativa", min_length=1, max_length=160)
    mode: Literal["DIRECT", "BENCHMARK"]
    session_ids: list[str] = Field(default_factory=list, max_length=100)
    reference_session_id: str | None = None
    gps_reference_session_id: str | None = None
    gps_enabled: bool = False
    assume_same_workout: bool = False
    offsets: dict[str, float] = Field(default_factory=dict)
    interpolation: Literal["NONE", "LINEAR"] = "NONE"
    source_resolution:Literal["EPOCH_SECOND_MEAN","NATIVE"]="EPOCH_SECOND_MEAN"
    sampling_hz:Literal[1,2,5,10]=1
    max_interpolation_gap: int = Field(default=5, ge=1, le=30)
    start_sec: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    end_sec: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    protocol_id: str | None = None
    protocol_version: int | None = Field(default=None, ge=1)
    benchmark_method: Literal["LEGACY", "CURRENT"] = "LEGACY"
    visualization: Visualization = Field(default_factory=Visualization)
    exclusions: list[Exclusion] = Field(default_factory=list, max_length=30)
    intervals: list[TimeInterval] = Field(default_factory=list, max_length=30)
    advanced: AdvancedOptions = Field(default_factory=AdvancedOptions)
    aggregation: Literal["SESSION", "DURATION", "VALID_PAIRS", "MANUAL"] = "SESSION"
    manual_weights: dict[str, float] = Field(default_factory=dict)
    uncertainty: UncertaintyOptions = Field(default_factory=UncertaintyOptions)
    storage_mode: Literal["SNAPSHOT", "LIVE"] = "SNAPSHOT"
    selection_policy: Literal["EXPLICIT", "ALL_COMPATIBLE"] = "EXPLICIT"
    filters: SessionFilters = Field(default_factory=SessionFilters)

    @model_validator(mode="after")
    def validate_selection(self):
        if self.sampling_hz!=1 and self.source_resolution!='NATIVE':raise ValueError('Una frecuencia superior a 1 Hz requiere lectura nativa.')
        if self.selection_policy == "EXPLICIT" and len(self.session_ids)<2:
            raise ValueError("Selecciona al menos dos sesiones.")
        if self.selection_policy == "ALL_COMPATIBLE" and (self.mode!="BENCHMARK" or len(set(self.filters.device_ids))<2 or not self.filters.sport_type or not self.filters.session_difficulty):
            raise ValueError("Todas compatibles requiere benchmark, al menos dos dispositivos y categoría de deporte/intensidad.")
        if len(set(self.session_ids)) != len(self.session_ids):
            raise ValueError("No se puede contar dos veces una misma sesión.")
        if set(self.visualization.hidden) - set(self.session_ids) - {"reference", "gps-reference"}:
            raise ValueError("Solo se pueden ocultar series de la selección.")
        if self.mode == "DIRECT" and len(self.session_ids)>8:
            raise ValueError("Máximo 8 dispositivos por comparación directa.")
        for sid in (self.reference_session_id, self.gps_reference_session_id):
            if sid and sid not in self.session_ids:
                raise ValueError("La referencia debe proceder de una sesión seleccionada.")
        if any(k not in self.session_ids or not finite(v) or abs(v)>3600 for k,v in self.offsets.items()):
            raise ValueError("Offsets inválidos; máximo ±3600 s y solo para sesiones seleccionadas.")
        if self.end_sec is not None and self.end_sec <= (self.start_sec or 0):
            raise ValueError("El final debe ser posterior al inicio.")
        if self.mode == "BENCHMARK" and (self.offsets or self.start_sec is not None or self.end_sec is not None or self.exclusions or self.intervals):
            raise ValueError("Un benchmark no admite una ventana u offset temporal común.")
        if any(k not in self.session_ids or not finite(v) or v<0 or v>1e9 for k,v in self.manual_weights.items()):
            raise ValueError("Pesos manuales inválidos.")
        if self.aggregation == "MANUAL" and set(self.manual_weights) != set(self.session_ids):
            raise ValueError("Indica un peso explícito para cada sesión.")
        return self


class ExperimentInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=160)
    session_ids: list[str] = Field(min_length=1, max_length=20)
    reference_session_id: str
    gps_reference_session_id: str | None = None
    protocol_id: str | None = None
    protocol_version: int = Field(default=1, ge=1)
    reference_quality: Literal["GOLD_STANDARD", "RESEARCH_GRADE", "VALIDATED_REFERENCE", "PRACTICAL_REFERENCE", "COMPARATIVE_REFERENCE"] | None = None
    notes: str = Field(default="", max_length=2000)


class ReferenceUpdate(BaseModel):
    model_config=ConfigDict(extra="forbid")
    reference_session_id:str
    gps_reference_session_id:str|None=None
    hr_quality:Literal["GOLD_STANDARD","RESEARCH_GRADE","VALIDATED_REFERENCE","PRACTICAL_REFERENCE","COMPARATIVE_REFERENCE"]|None=None
    gps_quality:Literal["GOLD_STANDARD","RESEARCH_GRADE","VALIDATED_REFERENCE","PRACTICAL_REFERENCE","COMPARATIVE_REFERENCE"]|None=None
    notes:str=Field(default="",max_length=2000)


PROTOCOLS = [
    {"id": k, "version": 1, "name": name, "category": cat, "specification": None}
    for k, name, cat in [
        ("HR_RUNNING_EASY", "Carrera suave", "running"),
        ("HR_RUNNING_TEMPO", "Tempo", "running"),
        ("HR_INTERVAL_SHORT", "Series cortas", "running"),
        ("HR_INTERVAL_LONG", "Series largas", "running"),
        ("HR_CYCLING_STEADY", "Ciclismo continuo", "cycling"),
        ("HR_CYCLING_INTERVAL", "Intervalos ciclismo", "cycling"),
        ("HR_STRENGTH", "Fuerza", "gym"),
        ("GPS_TRACK", "GPS pista", "gps"),
        ("GPS_URBAN", "GPS urbano", "gps"),
        ("HRV_NIGHT", "HRV nocturna", "night"),
    ]
]

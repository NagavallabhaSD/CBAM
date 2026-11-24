import os
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent

class Settings(BaseSettings):
    PROJECT_NAME: str = "CBAM-Ready Emissions Passport"
    PROJECT_VERSION: str = "1.0.0"
    API_V1_STR: str = "/api/v1"

    # Base Paths
    BASE_DIR: Path = BASE_DIR
    DATA_DIR: Path = BASE_DIR / "data"
    UPLOAD_DIR: Path = BASE_DIR / "data" / "uploads"
    SAMPLE_DOCS_DIR: Path = BASE_DIR / "data" / "sample_docs"
    REPORT_OUTPUT_DIR: Path = BASE_DIR / "data" / "reports"
    RAG_DATA_DIR: Path = BASE_DIR / "data" / "regulatory_docs"
    FAISS_INDEX_DIR: Path = BASE_DIR / "data" / "faiss_index"

    # SQLite Database
    DATABASE_URL: str = f"sqlite:///{BASE_DIR}/data/cbam_passport.db"

    # LLM Settings (OpenAI / Ollama / Open-source fallback)
    LLM_PROVIDER: str = "local"  # "local", "ollama", "openai"
    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")
    OLLAMA_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    OLLAMA_MODEL: str = os.getenv("OLLAMA_MODEL", "llama3")

    # Data-quality label thresholds (Task 3). PLACEHOLDERS to agree with the mentor:
    # A = all measured, B = fallback share below DQ_C_THRESHOLD, C = at or above it.
    DQ_C_THRESHOLD: float = 0.20

    # Fixed tolerances (+/- fraction at 95 %) for measured inputs in the Monte Carlo.
    # Fallback inputs use the distribution stored on their register row instead.
    MC_TOL_ELECTRICITY: float = 0.02
    MC_TOL_FUEL: float = 0.05
    MC_TOL_PRECURSOR: float = 0.03
    MC_TOL_MEASURED_FACTOR: float = 0.0  # document-backed factors are taken as stated unless a tolerance is given
    MC_TOL_PROCESS_DIRECT: float = 0.05
    MC_DEFAULT_SEED: int = 42
    MC_DEFAULT_ITERATIONS: int = 5000

    # Carbon-reduction tips (Priority 2): the size of each illustrative lever.
    # Every saving is recalculated by the engine; these only set the "what if".
    TIP_ELECTRICITY_CUT: float = 0.10
    TIP_PPA_SHARE: float = 0.50
    TIP_PPA_EF: float = 0.0  # tCO2/MWh assumed for renewable PPA electricity
    TIP_FUEL_CUT: float = 0.10
    TIP_SUPPLIER_SEE_CUT: float = 0.20
    TIP_PRECURSOR_YIELD: float = 0.02
    TIP_SWITCH_TO_FUEL: str = "natural_gas"
    SENSITIVITY_SWING: float = 0.10  # +/- 10 % one-at-a-time

    # Embeddings
    EMBEDDING_MODEL_NAME: str = "all-MiniLM-L6-v2"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

settings = Settings()

# Ensure runtime directories exist
for path in [
    settings.DATA_DIR,
    settings.UPLOAD_DIR,
    settings.SAMPLE_DOCS_DIR,
    settings.REPORT_OUTPUT_DIR,
    settings.RAG_DATA_DIR,
    settings.FAISS_INDEX_DIR,
]:
    path.mkdir(parents=True, exist_ok=True)

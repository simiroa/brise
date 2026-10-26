// AppError ↔ {code, message} — 프론트 계약 (commands/_conventions.yaml)
// 이 직렬화 형태({code,message})는 변경 금지.

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Db(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "NOT_FOUND",
            Self::Validation(_) => "VALIDATION",
            Self::Conflict(_) => "CONFLICT",
            Self::Io(_) => "IO",
            Self::Db(_) => "DB",
        }
    }
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// rusqlite 에러 → AppError::Db 매핑 (repo 계층 `.map_err(db)`용).
pub fn db(e: rusqlite::Error) -> AppError {
    AppError::Db(e.to_string())
}

/// std::io 에러 → AppError::Io 매핑.
pub fn io(e: std::io::Error) -> AppError {
    AppError::Io(e.to_string())
}

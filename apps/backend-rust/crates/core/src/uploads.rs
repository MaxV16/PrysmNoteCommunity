//! Authenticated image uploads stored in Postgres and served back to the app.

use axum::body::Body;
use axum::extract::{Multipart, Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::auth::{self, AuthUser};
use crate::error::ApiError;
use crate::{db, AppState};

const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const IMAGE_MIME: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const FILENAME_MAX: usize = 255;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/uploads", post(upload_image))
        .route("/api/uploads/", post(upload_image))
        .route("/api/uploads/{upload_id}", get(get_image))
}

fn require_user(state: &AppState, headers: &HeaderMap) -> Result<AuthUser, ApiError> {
    let token = auth::token_from_headers(headers)
        .ok_or_else(|| ApiError::Unauthorized("Not authenticated".to_string()))?;
    auth::authenticate(&state.settings.jwt_secret_key, &token)
}

fn db_error(err: sqlx::Error) -> ApiError {
    ApiError::Internal(format!("database error: {err}"))
}

/// Identify an allowed image by its magic bytes. The multipart `Content-Type`
/// is attacker-controlled, so it is only accepted when it agrees with the
/// actual payload. Returns `None` for SVG/HTML/garbage (they stay rejected).
fn sniff_image_mime(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

async fn upload_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut upload: Option<(String, String, Vec<u8>)> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(format!("Invalid multipart body: {e}")))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field
            .file_name()
            .map(str::to_string)
            .unwrap_or_else(|| "image".to_string());
        let mime = field.content_type().map(str::to_string).unwrap_or_default();
        let bytes = field
            .bytes()
            .await
            .map_err(|e| ApiError::BadRequest(format!("Could not read image: {e}")))?;
        if bytes.is_empty() {
            return Err(ApiError::BadRequest("The image file is empty".to_string()));
        }
        upload = Some((mime, filename, bytes.to_vec()));
        break;
    }

    let Some((mime, filename, data)) = upload else {
        return Err(ApiError::BadRequest(
            "Attach an image in the 'file' field".to_string(),
        ));
    };
    if !IMAGE_MIME.contains(&mime.as_str()) {
        return Err(ApiError::BadRequest(
            "Only PNG, JPEG, GIF or WebP images are supported".to_string(),
        ));
    }
    if data.len() > MAX_IMAGE_BYTES {
        return Err(ApiError::PayloadTooLarge(
            "Images must be 5 MB or smaller".to_string(),
        ));
    }
    // Trust the bytes, not the declared type: reject a payload whose magic
    // number is not one of the allowed images, or that contradicts the type
    // the client claimed.
    let Some(sniffed) = sniff_image_mime(&data) else {
        return Err(ApiError::BadRequest(
            "The file does not look like a PNG, JPEG, GIF or WebP image".to_string(),
        ));
    };
    if sniffed != mime {
        return Err(ApiError::BadRequest(
            "The declared image type does not match the file contents".to_string(),
        ));
    }

    let filename: String = filename.chars().take(FILENAME_MAX).collect();
    let size = data.len() as i32;

    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    let row = sqlx::query(
        "INSERT INTO uploads (user_id, mime, filename, size, data) \
         VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(user.user_id)
    .bind(&mime)
    .bind(&filename)
    .bind(size)
    .bind(&data)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;

    let id: Uuid = row.get("id");
    Ok(Json(json!({
        "id": id.to_string(),
        "url": format!("/api/uploads/{id}"),
        "mime": mime,
        "filename": filename,
        "size": size,
    })))
}

async fn get_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(upload_id): Path<Uuid>,
) -> Result<Response, ApiError> {
    let user = require_user(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(db_error)?;
    db::set_rls_user(&mut *tx, user.user_id, "")
        .await
        .map_err(db_error)?;
    let row = sqlx::query("SELECT mime, data FROM uploads WHERE id = $1 AND user_id = $2")
        .bind(upload_id)
        .bind(user.user_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;

    let Some(row) = row else {
        return Err(ApiError::NotFound("Image not found".to_string()));
    };
    let mime: String = row.get("mime");
    let data: Vec<u8> = row.get("data");

    let mut response = Response::new(Body::from(data));
    *response.status_mut() = StatusCode::OK;
    let response_headers = response.headers_mut();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&mime)
            .map_err(|_| ApiError::Internal("stored image type is invalid".to_string()))?,
    );
    response_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    response_headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_types_and_limits_are_bounded() {
        assert!(IMAGE_MIME.contains(&"image/png"));
        assert!(IMAGE_MIME.contains(&"image/jpeg"));
        assert!(!IMAGE_MIME.contains(&"image/svg+xml"));
        assert!(!IMAGE_MIME.contains(&"text/html"));
        assert_eq!(MAX_IMAGE_BYTES, 5 * 1024 * 1024);
        assert_eq!(FILENAME_MAX, 255);
    }

    #[test]
    fn magic_bytes_identify_each_allowed_image() {
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0];
        assert_eq!(sniff_image_mime(&png), Some("image/png"));

        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0, 0];
        assert_eq!(sniff_image_mime(&jpeg), Some("image/jpeg"));

        let gif87 = b"GIF87a\x01\x00".as_slice();
        let gif89 = b"GIF89a\x01\x00".as_slice();
        assert_eq!(sniff_image_mime(gif87), Some("image/gif"));
        assert_eq!(sniff_image_mime(gif89), Some("image/gif"));

        let mut webp = b"RIFF\x00\x00\x00\x00WEBP".to_vec();
        webp.extend_from_slice(b"VP8 ");
        assert_eq!(sniff_image_mime(&webp), Some("image/webp"));
    }

    #[test]
    fn mismatched_and_garbage_payloads_are_rejected() {
        // A PNG declared as a JPEG contradicts its bytes.
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        assert_eq!(sniff_image_mime(&png), Some("image/png"));
        assert_ne!(sniff_image_mime(&png), Some("image/jpeg"));

        // SVG/HTML and random bytes are not allowed images at all.
        assert_eq!(
            sniff_image_mime(b"<svg xmlns=\"http://www.w3.org/2000/svg\">"),
            None
        );
        assert_eq!(sniff_image_mime(b"<html><body>hi</body></html>"), None);
        assert_eq!(sniff_image_mime(&[0x00, 0x01, 0x02, 0x03]), None);
        assert_eq!(sniff_image_mime(b""), None);
    }
}

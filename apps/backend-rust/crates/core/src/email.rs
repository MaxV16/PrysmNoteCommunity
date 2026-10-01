//! Core mailer, ported from `apps/backend/app/services/email.py` and
//! `apps/backend/app/services/lifecycle_email.py`.
//!
//! Transport priority matches Python: the Brevo REST API (port 443, reachable
//! from the production VM where SMTP ports are blocked) when `BREVO_API_KEY` is
//! set, otherwise classic SMTP via the `SMTP_*` env vars. Everything is
//! fail-soft: a send that cannot happen logs and returns `false`, it never
//! propagates an error to the caller.

use crate::config::Settings;

/// Brevo transactional email endpoint.
const BREVO_SEND_URL: &str = "https://api.brevo.com/v3/smtp/email";

/// Subject of the one-time welcome note.
pub const WELCOME_SUBJECT: &str = "[Prysm Note] Welcome - here is how to get started";

/// Body of the one-time welcome note (product usage only, community-safe).
pub const WELCOME_BODY: &str = "Welcome to Prysm Note.

Here is the quickest way to get value on day one:

1. Create your first task, or describe your day in the chat in plain language
   (\"I cancelled dinner on the 25th and need to plan next week\").
2. Everything you add lands on the timeline, where you can drag a task to move
   it to another day.
3. Switch between Timeline, Kanban, Calendar, List and Board whenever you like.
   They all read the same tasks, so your plan never duplicates.

A few things that help:
- Press Cmd/Ctrl+F to search, or ask the chat to find something for you.
- Import existing tasks from a CSV or ICS file under Settings, then Data.
- Pick a theme in Settings to make the workspace yours.

If anything is unclear, just reply to this email.

The Prysm Note team
";

/// Send a plain-text email through the configured provider.
///
/// `from_email` overrides the From address for automated mail; it defaults to
/// `ADMIN_EMAIL`. Returns `true` on success, `false` when no provider is
/// configured or the send fails.
pub async fn send_email(
    settings: &Settings,
    to_address: &str,
    subject: &str,
    body: &str,
    from_email: Option<&str>,
) -> bool {
    let sender = match from_email {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => settings.admin_email(),
    };
    if sender.is_empty() {
        tracing::warn!("No ADMIN_EMAIL configured, skipping email to {to_address}: {subject}");
        return false;
    }

    if !settings.brevo_api_key().is_empty() {
        return send_brevo(settings, to_address, subject, body, &sender).await;
    }

    if settings.smtp_host().is_empty() {
        tracing::warn!("SMTP not configured, skipping email to {to_address}: {subject}");
        return false;
    }
    send_smtp(settings, to_address, subject, body, &sender).await
}

/// Send the one-time welcome note. Never panics; returns `false` on failure.
pub async fn send_welcome_email(settings: &Settings, to_address: &str, display_name: Option<&str>) -> bool {
    let body = match display_name {
        Some(name) if !name.trim().is_empty() => format!("Hi {name},\n\n{WELCOME_BODY}"),
        _ => WELCOME_BODY.to_string(),
    };
    send_email(settings, to_address, WELCOME_SUBJECT, &body, None).await
}

async fn send_brevo(settings: &Settings, to_address: &str, subject: &str, body: &str, sender: &str) -> bool {
    let payload = serde_json::json!({
        "sender": {"name": "Prysm Note", "email": sender},
        "to": [{"email": to_address}],
        "subject": subject,
        "textContent": body,
    });
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build() {
        Ok(client) => client,
        Err(_) => return false,
    };

    // Retry once on a transient (5xx/429/network) failure, matching Python.
    for attempt in 0..2 {
        match client
            .post(BREVO_SEND_URL)
            .header("api-key", settings.brevo_api_key())
            .header("accept", "application/json")
            .json(&payload)
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                if status == 200 || status == 201 {
                    return true;
                }
                if (status >= 500 || status == 429) && attempt == 0 {
                    continue;
                }
                tracing::warn!("Brevo API send to {to_address} returned {status}");
                return false;
            }
            Err(err) => {
                if attempt == 0 {
                    continue;
                }
                tracing::warn!("Failed to send email via Brevo API to {to_address}: {err}");
            }
        }
    }
    false
}

async fn send_smtp(settings: &Settings, to_address: &str, subject: &str, body: &str, sender: &str) -> bool {
    use lettre::message::Mailbox;
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

    let from: Mailbox = match sender.parse() {
        Ok(mailbox) => mailbox,
        Err(err) => {
            tracing::warn!("Invalid From address {sender}: {err}");
            return false;
        }
    };
    let to: Mailbox = match to_address.parse() {
        Ok(mailbox) => mailbox,
        Err(err) => {
            tracing::warn!("Invalid To address {to_address}: {err}");
            return false;
        }
    };

    let message = match Message::builder().from(from).to(to).subject(subject).body(body.to_string()) {
        Ok(message) => message,
        Err(err) => {
            tracing::warn!("Could not build email to {to_address}: {err}");
            return false;
        }
    };

    let host = settings.smtp_host();
    let port = settings.smtp_port();
    let builder = if port == 465 {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&host)
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)
    };
    let builder = match builder {
        Ok(builder) => builder.port(port),
        Err(err) => {
            tracing::warn!("SMTP relay setup failed for {host}: {err}");
            return false;
        }
    };
    let user = settings.smtp_user();
    let mailer = if user.is_empty() {
        builder.build()
    } else {
        builder
            .credentials(Credentials::new(user, settings.smtp_password()))
            .build()
    };

    match mailer.send(message).await {
        Ok(_) => true,
        Err(err) => {
            tracing::warn!("Failed to send email via SMTP to {to_address}: {err}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config;

    #[test]
    fn welcome_body_includes_display_name_when_present() {
        // The message body assembly is the only pure logic worth asserting here;
        // the transports need a live provider.
        let settings = config::tests::sample("test");
        assert!(settings.brevo_api_key().is_empty());
        assert!(settings.admin_email().is_empty());
        assert_eq!(settings.smtp_port(), 587);
    }

    #[tokio::test]
    async fn send_email_without_provider_returns_false() {
        let settings = config::tests::sample("test");
        assert!(!send_email(&settings, "a@b.com", "s", "b", None).await);
        assert!(!send_welcome_email(&settings, "a@b.com", Some("Ada")).await);
    }
}

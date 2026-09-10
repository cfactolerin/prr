use crate::config::Config;
use std::error::Error;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const SMOKE_TIMEOUT: Duration = Duration::from_secs(45);
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_CONCURRENCY: usize = 4;
const PROBE_MAX_CANDIDATES: usize = 8;
const PROBE_TARGET_WORKING: usize = 3;

const SMOKE_PROMPT: &str = "Reply with exactly: HELLO";

// ── stream verdict ─────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
pub enum Verdict {
    Healthy(String),
    Failed(String),
}

/// Classify one `opencode run --format json` stream.
///
/// opencode exits 0 even when the model call fails, and a run that dies
/// mid-stream still emits the text it produced before the error, so an error
/// event anywhere outranks any text that came with it.
pub fn verdict_from_stream(stdout: &str) -> Verdict {
    let mut text = String::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let event: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match event.get("type").and_then(|t| t.as_str()) {
            Some("error") => {
                return Verdict::Failed(error_message(&event));
            }
            Some("text") => {
                if let Some(part) = event.pointer("/part/text").and_then(|t| t.as_str()) {
                    text.push_str(part);
                }
            }
            _ => {}
        }
    }

    if text.trim().is_empty() {
        Verdict::Failed("no text in stream".into())
    } else {
        Verdict::Healthy(text.trim().to_string())
    }
}

fn error_message(event: &serde_json::Value) -> String {
    if let Some(msg) = event.pointer("/error/data/message").and_then(|m| m.as_str()) {
        return msg.to_string();
    }
    if let Some(name) = event.pointer("/error/name").and_then(|n| n.as_str()) {
        return name.to_string();
    }
    "unknown error".into()
}

// ── candidate ranking ──────────────────────────────────────────────────────

/// Pick the openai models out of `opencode models` output, best first.
///
/// Ranked newest version first, and a plain variant ahead of its `-fast`
/// sibling: this model reviews code rather than chats, so latency is worth
/// less than depth. Provider-prefixed ids such as
/// `google-vertex/openai/gpt-oss-120b-maas` are a different provider that
/// happens to carry "openai" in the path, so they are dropped.
pub fn openai_candidates(models_output: &str) -> Vec<String> {
    let mut ids: Vec<String> = models_output
        .lines()
        .map(|l| l.trim())
        .filter(|l| l.starts_with("openai/"))
        .map(|l| l.to_string())
        .collect();

    ids.sort_by(|a, b| {
        model_version(b)
            .partial_cmp(&model_version(a))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(is_fast(a).cmp(&is_fast(b)))
            .then(a.cmp(b))
    });
    ids.dedup();
    ids
}

fn model_version(id: &str) -> f64 {
    let rest = match id.strip_prefix("openai/gpt-") {
        Some(r) => r,
        None => return 0.0,
    };
    let digits: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    digits.parse().unwrap_or(0.0)
}

fn is_fast(id: &str) -> bool {
    id.ends_with("-fast")
}

// ── running opencode ───────────────────────────────────────────────────────

/// Run opencode and capture stdout, killing it if it outruns `timeout`.
///
/// A wedged opencode writes nothing at all — no stdout, no stderr — so the
/// caller can't distinguish "still thinking" from "hung" by watching output.
/// The deadline is the only reliable way out.
fn run_capture(args: &[String], timeout: Duration) -> Result<Option<String>, Box<dyn Error>> {
    let mut child = Command::new("opencode")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or("could not capture opencode stdout")?;

    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    loop {
        match child.try_wait()? {
            Some(_) => break,
            None => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        }
    }

    if timed_out {
        return Ok(None);
    }
    Ok(Some(rx.recv_timeout(Duration::from_secs(5))?))
}

fn smoke_test(model: &str, timeout: Duration) -> Verdict {
    let args = vec![
        "run".to_string(),
        "--model".to_string(),
        model.to_string(),
        "--format".to_string(),
        "json".to_string(),
        SMOKE_PROMPT.to_string(),
    ];
    match run_capture(&args, timeout) {
        Ok(Some(out)) => verdict_from_stream(&out),
        Ok(None) => Verdict::Failed(format!(
            "no output within {}s (opencode wedged)",
            timeout.as_secs()
        )),
        Err(e) => Verdict::Failed(format!("could not run opencode: {e}")),
    }
}

fn list_models() -> Vec<String> {
    match run_capture(&["models".to_string()], Duration::from_secs(30)) {
        Ok(Some(out)) => openai_candidates(&out),
        _ => Vec::new(),
    }
}

/// Probe candidates in small parallel batches, stopping as soon as enough
/// respond. Refused models are cheap, but the ones opencode treats as
/// retryable burn the whole timeout, so the candidate list is capped too.
fn probe_candidates(exclude: &str) -> Vec<String> {
    let candidates: Vec<String> = list_models()
        .into_iter()
        .filter(|m| m != exclude)
        .take(PROBE_MAX_CANDIDATES)
        .collect();

    let mut working = Vec::new();

    for batch in candidates.chunks(PROBE_CONCURRENCY) {
        let handles: Vec<_> = batch
            .iter()
            .map(|model| {
                let model = model.clone();
                thread::spawn(move || {
                    let started = Instant::now();
                    let verdict = smoke_test(&model, PROBE_TIMEOUT);
                    (model, verdict, started.elapsed())
                })
            })
            .collect();

        for handle in handles {
            let (model, verdict, elapsed) = match handle.join() {
                Ok(r) => r,
                Err(_) => continue,
            };
            match verdict {
                Verdict::Healthy(_) => {
                    println!("  {model:<28} ok  ({:.1}s)", elapsed.as_secs_f64());
                    working.push(model);
                }
                Verdict::Failed(reason) => {
                    println!("  {model:<28} refused  ({})", truncate(&reason, 70));
                }
            }
        }

        if working.len() >= PROBE_TARGET_WORKING {
            break;
        }
    }

    working
}

fn truncate(s: &str, max: usize) -> String {
    let one_line = s.replace('\n', " ");
    if one_line.chars().count() <= max {
        return one_line;
    }
    one_line.chars().take(max).collect::<String>() + "…"
}

// ── public dispatch functions used by main.rs ──────────────────────────────

pub fn check() -> Result<(), Box<dyn Error>> {
    let cfg = Config::load()?;
    let model = cfg.opencode_model.clone();

    match smoke_test(&model, SMOKE_TIMEOUT) {
        Verdict::Healthy(_) => {
            println!("opencode_model {model} -> ok");
            Ok(())
        }
        Verdict::Failed(reason) => {
            println!("opencode_model {model} -> FAILED");
            println!("  {}", truncate(&reason, 200));
            println!();
            println!("probing candidates...");

            let working = probe_candidates(&model);
            println!();
            if working.is_empty() {
                println!("working models: none");
            } else {
                println!("working models:");
                for m in &working {
                    println!("  {m}");
                }
            }
            Err("opencode health check failed".into())
        }
    }
}

pub fn set_model(id: &str) -> Result<(), Box<dyn Error>> {
    let id = id.trim();
    if id.is_empty() {
        return Err("model id cannot be empty".into());
    }
    let mut cfg = Config::load()?;
    cfg.opencode_model = id.to_string();
    cfg.save()?;
    println!("Set opencode_model to '{id}'");
    Ok(())
}

// ── tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_healthy_stream() {
        let stream = r#"
{"type":"step-start","sessionID":"ses_1"}
{"type":"text","part":{"text":"HELLO"}}
"#;
        assert_eq!(
            verdict_from_stream(stream),
            Verdict::Healthy("HELLO".into())
        );
    }

    #[test]
    fn test_error_stream_reports_provider_message() {
        let stream = r#"{"type":"error","error":{"name":"APIError","data":{"message":"The model `gpt-5.5` does not exist or you do not have access to it."}}}"#;
        assert_eq!(
            verdict_from_stream(stream),
            Verdict::Failed(
                "The model `gpt-5.5` does not exist or you do not have access to it.".into()
            )
        );
    }

    #[test]
    fn test_error_outranks_partial_text() {
        let stream = r#"
{"type":"text","part":{"text":"I'll review the branch"}}
{"type":"error","error":{"name":"APIError","data":{"message":"Bad Request"}}}
"#;
        assert_eq!(verdict_from_stream(stream), Verdict::Failed("Bad Request".into()));
    }

    #[test]
    fn test_empty_stream_is_a_failure() {
        assert_eq!(
            verdict_from_stream(""),
            Verdict::Failed("no text in stream".into())
        );
    }

    #[test]
    fn test_stream_of_only_noise_is_a_failure() {
        let stream = "{\"type\":\"step-start\"}\nnot json at all\n";
        assert_eq!(
            verdict_from_stream(stream),
            Verdict::Failed("no text in stream".into())
        );
    }

    #[test]
    fn test_error_without_message_falls_back_to_name() {
        let stream = r#"{"type":"error","error":{"name":"ProviderAuthError"}}"#;
        assert_eq!(
            verdict_from_stream(stream),
            Verdict::Failed("ProviderAuthError".into())
        );
    }

    #[test]
    fn test_candidates_are_newest_first() {
        let models = "\
anthropic/claude-opus-4
google-vertex/openai/gpt-oss-120b-maas
openai/gpt-5.4
openai/gpt-5.5
openai/gpt-5.6-sol
openai/gpt-6-astra
";
        assert_eq!(
            openai_candidates(models),
            vec![
                "openai/gpt-6-astra",
                "openai/gpt-5.6-sol",
                "openai/gpt-5.5",
                "openai/gpt-5.4",
            ]
        );
    }

    #[test]
    fn test_plain_variant_outranks_fast() {
        let models = "openai/gpt-6-astra-fast\nopenai/gpt-6-astra\n";
        assert_eq!(
            openai_candidates(models),
            vec!["openai/gpt-6-astra", "openai/gpt-6-astra-fast"]
        );
    }

    #[test]
    fn test_other_providers_are_dropped() {
        let models = "google-vertex/openai/gpt-oss-120b-maas\nmoonshotai/kimi-k2\n";
        assert!(openai_candidates(models).is_empty());
    }

    #[test]
    fn test_model_version_parsing() {
        assert_eq!(model_version("openai/gpt-6-astra"), 6.0);
        assert_eq!(model_version("openai/gpt-5.6-sol"), 5.6);
        assert_eq!(model_version("openai/gpt-5.3-codex-spark"), 5.3);
        assert_eq!(model_version("openai/o3"), 0.0);
    }
}

use clap::{Parser, Subcommand};

mod config;
mod pr;
mod workspace;
mod git;
mod jira;
mod html;
mod context;
mod prompt;
mod report;
mod cleanup;
mod opencode;

#[derive(Parser)]
#[command(name = "prr", about = "PRR — AI-powered PR review tool")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Gather context for a PR review
    Context {
        /// PR URL or owner/repo#N
        pr: String,
        /// Workspace path
        #[arg(long)]
        workspace: String,
        /// Jira ticket ID override
        #[arg(long)]
        ticket: Option<String>,
    },
    /// Gather context using the configured OpenCode workspace
    ContextOpenCode {
        /// PR URL or owner/repo#N
        pr: String,
        /// Jira ticket ID override
        #[arg(long)]
        ticket: Option<String>,
    },
    /// Assemble a prompt from gathered context
    Prompt {
        /// Prompt type: review, arbiter, question
        #[arg(long)]
        review: bool,
        #[arg(long)]
        arbiter: bool,
        #[arg(long)]
        question: bool,
        /// Context directory path
        context_dir: String,
        /// Agent name (for question prompts)
        #[arg(long)]
        agent: Option<String>,
        /// Questions JSON (for question prompts)
        #[arg(long, conflicts_with = "questions_file")]
        questions: Option<String>,
        /// Path to questions JSON (for question prompts)
        #[arg(long, conflicts_with = "questions")]
        questions_file: Option<String>,
        /// Q&A round number (for question prompts)
        #[arg(long)]
        round: Option<u32>,
        /// Review tasks JSON (for review prompts)
        #[arg(long, conflicts_with = "tasks_file")]
        tasks: Option<String>,
        /// Path to review tasks JSON (for review prompts)
        #[arg(long, conflicts_with = "tasks")]
        tasks_file: Option<String>,
    },
    /// Parse a final report into JSON
    ParseReport {
        /// Path to final-report.md
        report_path: String,
        /// Optional path to the PR diff for anchor verification
        #[arg(long)]
        diff: Option<String>,
    },
    /// Clean up workspace (remove merged/closed PRs)
    Cleanup {
        /// Workspace path
        #[arg(long)]
        workspace: String,
    },
    /// Clean up the configured OpenCode workspace
    CleanupOpenCode,
    /// Read or update OpenCode runtime configuration without exposing secrets
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Manage agent list in config
    Agents {
        #[command(subcommand)]
        action: AgentAction,
    },
    /// Check and heal the opencode model setting
    Opencode {
        #[command(subcommand)]
        action: OpencodeAction,
    },
}

#[derive(Subcommand)]
enum AgentAction {
    /// List configured agents
    List,
    /// Add an agent
    Add { name: String },
    /// Remove an agent
    Delete { name: String },
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Print non-secret settings as JSON
    Runtime,
    /// Apply OpenCode defaults while preserving existing Jira credentials
    ConfigureOpenCode {
        /// Workspace path
        #[arg(long)]
        workspace: String,
        /// Remove existing Jira settings
        #[arg(long)]
        clear_jira: bool,
    },
}

#[derive(Subcommand)]
enum OpencodeAction {
    /// Smoke-test the configured model, probing replacements if it fails
    Check,
    /// Set the model the opencode reviewer runs with
    SetModel { id: String },
}

fn main() {
    if let Err(e) = run(Cli::parse()) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    match cli.command {
        Commands::Context { pr, workspace, ticket } => {
            context::run(&pr, &workspace, ticket.as_deref())
        }
        Commands::ContextOpenCode { pr, ticket } => {
            let workspace = config::Config::load()?.expanded_workspace_path();
            context::run(&pr, &workspace.to_string_lossy(), ticket.as_deref())
        }
        Commands::Prompt {
            review,
            arbiter,
            question,
            context_dir,
            agent,
            questions,
            questions_file,
            round,
            tasks,
            tasks_file,
        } => {
            let results_dir = std::path::Path::new(&context_dir).join("results");
            if review {
                let tasks = value_or_file(tasks, tasks_file, Some(&results_dir))?;
                prompt::build_review(&context_dir, tasks.as_deref())
            } else if arbiter {
                prompt::build_arbiter(&context_dir)
            } else if question {
                let questions = value_or_file(questions, questions_file, Some(&results_dir))?
                    .ok_or("--questions or --questions-file required for question prompt")?;
                prompt::build_question(
                    &context_dir,
                    agent.as_deref().ok_or("--agent required for question prompt")?,
                    &questions,
                    round,
                )
            } else {
                Err("Specify --review, --arbiter, or --question".into())
            }
        }
        Commands::ParseReport { report_path, diff } => report::parse_and_print(&report_path, diff.as_deref()),
        Commands::Cleanup { workspace } => cleanup::run(&workspace),
        Commands::CleanupOpenCode => {
            let workspace = config::Config::load()?.expanded_workspace_path();
            cleanup::run(&workspace.to_string_lossy())
        }
        Commands::Config { action } => match action {
            ConfigAction::Runtime => config::runtime(),
            ConfigAction::ConfigureOpenCode { workspace, clear_jira } => {
                config::configure_opencode(&workspace, clear_jira)
            }
        },
        Commands::Agents { action } => match action {
            AgentAction::List => config::agents_list(),
            AgentAction::Add { name } => config::agents_add(&name),
            AgentAction::Delete { name } => config::agents_delete(&name),
        },
        Commands::Opencode { action } => match action {
            OpencodeAction::Check => opencode::check(),
            OpencodeAction::SetModel { id } => opencode::set_model(&id),
        },
    }
}

fn value_or_file(
    value: Option<String>,
    path: Option<String>,
    allowed_dir: Option<&std::path::Path>,
) -> Result<Option<String>, Box<dyn std::error::Error>> {
    match (value, path) {
        (Some(value), None) => Ok(Some(value)),
        (None, Some(path)) => {
            let path = std::path::Path::new(&path).canonicalize()?;
            if let Some(allowed_dir) = allowed_dir {
                let allowed_dir = allowed_dir.canonicalize()?;
                if !path.starts_with(&allowed_dir) {
                    return Err("input file must be inside the context results directory".into());
                }
            }
            Ok(Some(std::fs::read_to_string(path)?))
        }
        (None, None) => Ok(None),
        (Some(_), Some(_)) => Err("provide a value or file, not both".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_value_or_file_preserves_untrusted_json() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let value = r#"{"opencode":["Don't trust $(touch /tmp/prr-injected)"]}"#;
        std::fs::write(file.path(), value).unwrap();

        let loaded = value_or_file(None, Some(file.path().display().to_string()), None).unwrap();
        assert_eq!(loaded.as_deref(), Some(value));
    }

    #[test]
    fn test_value_or_file_rejects_paths_outside_allowed_directory() {
        let allowed = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();

        let result = value_or_file(
            None,
            Some(outside.path().display().to_string()),
            Some(allowed.path()),
        );

        assert!(result.is_err());
    }
}

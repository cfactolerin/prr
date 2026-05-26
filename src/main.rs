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
        #[arg(long)]
        questions: Option<String>,
        /// Review tasks JSON (for review prompts)
        #[arg(long)]
        tasks: Option<String>,
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
    /// Manage agent list in config
    Agents {
        #[command(subcommand)]
        action: AgentAction,
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

fn main() {
    let cli = Cli::parse();
    let result = match cli.command {
        Commands::Context { pr, workspace, ticket } => {
            context::run(&pr, &workspace, ticket.as_deref())
        }
        Commands::Prompt { review, arbiter, question, context_dir, agent, questions, tasks } => {
            if review {
                prompt::build_review(&context_dir, tasks.as_deref())
            } else if arbiter {
                prompt::build_arbiter(&context_dir)
            } else if question {
                prompt::build_question(
                    &context_dir,
                    agent.as_deref().expect("--agent required for question prompt"),
                    questions.as_deref().expect("--questions required for question prompt"),
                )
            } else {
                Err("Specify --review, --arbiter, or --question".into())
            }
        }
        Commands::ParseReport { report_path, diff } => report::parse_and_print(&report_path, diff.as_deref()),
        Commands::Cleanup { workspace } => cleanup::run(&workspace),
        Commands::Agents { action } => match action {
            AgentAction::List => config::agents_list(),
            AgentAction::Add { name } => config::agents_add(&name),
            AgentAction::Delete { name } => config::agents_delete(&name),
        },
    };

    if let Err(e) = result {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

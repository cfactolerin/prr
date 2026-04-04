# frozen_string_literal: true

require "erb"

module Prr
  class PromptBuilder
    PROMPTS_DIR = File.expand_path("../../config/prompts", __dir__)

    def initialize(sandbox:, preflight:)
      @sandbox = sandbox
      @preflight = preflight
    end

    def review_prompt
      render("review.md.erb", review_context)
    end

    def arbiter_prompt(claude_review:, codex_review:, round_history: "")
      render("arbiter.md.erb", {
        claude_review: claude_review,
        codex_review: codex_review,
        round_history: round_history,
        **review_context
      })
    end

    def arbiter_question_prompt(agent_name:, questions:, previous_review:)
      render("arbiter_question.md.erb", {
        agent_name: agent_name,
        questions: questions,
        previous_review: previous_review,
        **review_context
      })
    end

    private

    def review_context
      pr = @preflight.pr_data
      ticket = @preflight.ticket_data
      base_branch = pr["baseRefName"]

      repo_docs = ["CLAUDE.md", "AGENTS.md", "README.md"]
                    .filter_map { |f| content = @sandbox.read_repo_file(f); "### #{f}\n#{content}" if content }
                    .join("\n\n")

      changed_files = (pr["files"] || []).map { |f| f["path"] }.join("\n")

      prev_path = @sandbox.previous_review_path
      previous_review = prev_path ? File.read(prev_path) : nil

      {
        pr_number: pr["number"],
        pr_title: pr["title"],
        pr_url: pr["url"],
        pr_author: pr.dig("author", "login") || "unknown",
        pr_body: pr["body"] || "",
        head_branch: pr["headRefName"],
        base_branch: base_branch,
        repo: @preflight.repo,
        ticket_id: @preflight.ticket_id || "None",
        ticket_summary: ticket&.dig("fields", "summary"),
        ticket_description: ticket&.dig("fields", "description"),
        repo_docs: repo_docs.empty? ? nil : repo_docs,
        changed_files: changed_files,
        diff: @sandbox.diff(base_branch),
        previous_review: previous_review
      }
    end

    def render(template_name, vars)
      path = File.join(PROMPTS_DIR, template_name)
      template = File.read(path)
      b = binding
      vars.each { |k, v| b.local_variable_set(k, v) }
      ERB.new(template, trim_mode: "-").result(b)
    end
  end
end

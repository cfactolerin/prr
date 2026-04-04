# frozen_string_literal: true

require "erb"
require "pathname"

module Prr
  class PromptBuilder
    PROMPTS_DIR = File.expand_path("../../config/prompts", __dir__)

    def initialize(sandbox:, preflight:, ticket_context_path: nil)
      @sandbox = sandbox
      @preflight = preflight
      @ticket_context_path = ticket_context_path
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
      base_branch = pr["baseRefName"]

      repo_docs = ["CLAUDE.md", "AGENTS.md", "README.md"]
                    .filter_map { |f| content = @sandbox.read_repo_file(f); "### #{f}\n#{content}" if content }
                    .join("\n\n")

      changed_files = (pr["files"] || []).map { |f| f["path"] }.join("\n")

      prev_path = @sandbox.previous_review_path
      previous_review = prev_path ? File.read(prev_path) : nil

      ticket_context = nil
      ticket_dir_hint = nil
      ticket_summary = nil
      if @ticket_context_path && File.exist?(@ticket_context_path)
        ticket_context = File.read(@ticket_context_path)
        ticket_dir_hint = Pathname.new(File.dirname(@ticket_context_path)).relative_path_from(Pathname.new(@sandbox.repo_path)).to_s
        # Extract summary from first line: "# TICKET-ID: Summary"
        first_line = ticket_context.lines.first&.strip
        ticket_summary = first_line&.sub(/^#\s*\S+:\s*/, "")
      end

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
        ticket_summary: ticket_summary,
        ticket_context: ticket_context,
        ticket_dir_hint: ticket_dir_hint,
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

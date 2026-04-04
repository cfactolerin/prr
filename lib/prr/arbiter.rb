# frozen_string_literal: true

require "json"
require "prr/progress"

module Prr
  class Arbiter
    def initialize(config:, agent_runner:, prompt_builder:, results_path:)
      @config = config
      @runner = agent_runner
      @builder = prompt_builder
      @results_path = results_path
      @log_lines = []
    end

    def run!(claude_review:, codex_review:)
      max_rounds = @config.arbiter_rounds
      round_history = ""

      Progress.log("Starting arbiter (max #{max_rounds} rounds)...")

      (1..max_rounds).each do |round|
        is_last = (round == max_rounds)
        Progress.log("Arbiter round #{round}/#{max_rounds}#{is_last ? " (forced choice)" : ""}...")

        arbiter_prompt = @builder.arbiter_prompt(
          claude_review: claude_review,
          codex_review: codex_review,
          round_history: round_history
        )

        if is_last
          arbiter_prompt += "\n\nThis is the FINAL round. For any remaining disagreements, present forced choices. Output your final-report.md directly."
        end

        response = run_arbiter(arbiter_prompt)

        questions = parse_questions(response)

        if questions.nil? || (questions["claude"].empty? && questions["codex"].empty?)
          @log_lines << "## Round #{round}\nNo questions. Proceeding to final report.\n"
          write_log!
          return response
        end

        @log_lines << "## Round #{round}\n"

        threads = []
        round_responses = {}

        if questions["claude"] && !questions["claude"].empty?
          q_text = format_questions(questions["claude"])
          Progress.indent("Asking Claude #{questions["claude"].length} question(s)...")
          @log_lines << "### Questions for Claude\n#{q_text}\n"

          threads << Thread.new do
            prompt = @builder.arbiter_question_prompt(
              agent_name: "Claude",
              questions: q_text,
              previous_review: claude_review
            )
            path = File.join(@results_path, "round-#{round}-claude.md")
            @runner.run_agent(:claude, prompt, path, @config.claude_timeout)
            round_responses[:claude] = File.exist?(path) ? File.read(path) : ""
          end
        else
          Progress.indent("No questions for Claude this round.")
          @log_lines << "### Questions for Claude\n(none)\n"
        end

        if questions["codex"] && !questions["codex"].empty?
          q_text = format_questions(questions["codex"])
          Progress.indent("Asking Codex #{questions["codex"].length} question(s)...")
          @log_lines << "### Questions for Codex\n#{q_text}\n"

          threads << Thread.new do
            prompt = @builder.arbiter_question_prompt(
              agent_name: "Codex",
              questions: q_text,
              previous_review: codex_review
            )
            path = File.join(@results_path, "round-#{round}-codex.md")
            @runner.run_agent(:codex, prompt, path, @config.codex_timeout)
            round_responses[:codex] = File.exist?(path) ? File.read(path) : ""
          end
        else
          Progress.indent("No questions for Codex this round.")
          @log_lines << "### Questions for Codex\n(none)\n"
        end

        threads.each(&:join)
        Progress.indent("Responses received.")

        if round_responses[:claude]
          @log_lines << "### Claude Response\n#{round_responses[:claude]}\n"
        end
        if round_responses[:codex]
          @log_lines << "### Codex Response\n#{round_responses[:codex]}\n"
        end

        round_history += "\n## Round #{round} Q&A\n"
        round_history += "Claude response: #{round_responses[:claude]}\n" if round_responses[:claude]
        round_history += "Codex response: #{round_responses[:codex]}\n" if round_responses[:codex]
      end

      Progress.log("Generating final report...")
      final_prompt = @builder.arbiter_prompt(
        claude_review: claude_review,
        codex_review: codex_review,
        round_history: round_history
      )
      final_prompt += "\n\nAll Q&A rounds are complete. Produce the final-report.md now."

      write_log!
      run_arbiter(final_prompt)
    end

    private

    def run_arbiter(prompt)
      path = File.join(@results_path, "arbiter-tmp-#{Time.now.to_i}.md")
      @runner.run_agent(:claude, prompt, path, @config.claude_timeout)
      File.exist?(path) ? File.read(path) : ""
    end

    def parse_questions(response)
      json_match = response.match(/```json\s*\n(.*?)\n\s*```/m)
      if json_match
        JSON.parse(json_match[1])
      else
        JSON.parse(response)
      end
    rescue JSON::ParserError
      nil
    end

    def format_questions(questions)
      if questions.is_a?(Array)
        questions.each_with_index.map { |q, i| "#{i + 1}. #{q}" }.join("\n")
      else
        questions.to_s
      end
    end

    def write_log!
      path = File.join(@results_path, "arbiter-log.md")
      File.write(path, "# Arbiter Log\n\n#{@log_lines.join("\n")}")
    end
  end
end

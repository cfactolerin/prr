# frozen_string_literal: true

require "prr/config"
require "prr/progress"
require "prr/preflight"
require "prr/sandbox"
require "prr/prompt_builder"
require "prr/agent_runner"
require "prr/arbiter"
require "prr/report"
require "prr/github_commenter"

module Prr
  class ReviewRunner
    def initialize(options)
      @options = options
      @config = Config.load(options)
    end

    def run
      preflight = Preflight.new(@config, @options).run!

      sandbox = Sandbox.new(@config, preflight.owner, preflight.repo, preflight.pr_number)

      check_previous_review(sandbox)

      sandbox.setup!

      prompt_builder = PromptBuilder.new(sandbox: sandbox, preflight: preflight)
      agent_runner = AgentRunner.new(config: @config, sandbox: sandbox, results_path: sandbox.results_path)

      if @options[:arbiter_only]
        reviews = load_existing_reviews(sandbox.results_path)
      else
        prompt = prompt_builder.review_prompt
        reviews = agent_runner.run_parallel_review!(prompt)
      end

      arbiter = Arbiter.new(
        config: @config,
        agent_runner: agent_runner,
        prompt_builder: prompt_builder,
        results_path: sandbox.results_path
      )
      final_content = arbiter.run!(claude_review: reviews[:claude], codex_review: reviews[:codex])

      report = Report.new(final_content)
      report_path = report.save!(sandbox.results_path)

      sandbox.cleanup!

      puts
      Progress.done("Done.")
      puts
      puts "Report: #{report_path}"
      puts "Verdict: #{report.verdict} (#{report.confidence} Confidence)"
      puts "#{report.line_comments.length} line comment(s) ready."
      puts

      commenter = GithubCommenter.new(
        @config, preflight.owner, preflight.repo, preflight.pr_number, report
      )
      commenter.run!
    end

    private

    def check_previous_review(sandbox)
      prev = sandbox.previous_review_path
      return unless prev

      timestamp = File.basename(File.dirname(prev))
      print "Previous review found from #{timestamp}. Use as context? (Y/n): "
      input = $stdin.gets&.strip&.downcase
      @options[:use_previous] = (input != "n")
    end

    def load_existing_reviews(results_path)
      claude_path = File.join(results_path, "claude-review.md")
      codex_path = File.join(results_path, "codex-review.md")

      {
        claude: File.exist?(claude_path) ? File.read(claude_path) : "",
        codex: File.exist?(codex_path) ? File.read(codex_path) : ""
      }
    end
  end
end

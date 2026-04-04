# frozen_string_literal: true

require "optparse"

module Prr
  class Cli
    def self.run(argv)
      new(argv).run
    end

    def initialize(argv)
      @argv = argv.dup
      @options = {}
    end

    def run
      if @argv.empty?
        require "prr/review_runner"
        Prr::ReviewRunner.new(@options).run
        return
      end

      case @argv.first
      when "--help", "-h"
        print_help
      when "setup"
        require "prr/setup"
        Prr::Setup.run
      else
        parse_options!
        if @options[:comments]
          require "prr/github_commenter"
          Prr::GithubCommenter.run_from_file(@options[:comments], @options)
        else
          require "prr/review_runner"
          Prr::ReviewRunner.new(@options).run
        end
      end
    end

    private

    def parse_options!
      first = @argv.first
      unless first&.start_with?("--")
        @options[:pr_url] = first
        @argv.shift
      end

      OptionParser.new do |opts|
        opts.on("--ticket TICKET") { |v| @options[:ticket] = v }
        opts.on("--arbiter-only") { @options[:arbiter_only] = true }
        opts.on("--comments PATH") { |v| @options[:comments] = v }
        opts.on("--claude-timeout SECONDS", Integer) { |v| @options[:claude_timeout] = v }
        opts.on("--codex-timeout SECONDS", Integer) { |v| @options[:codex_timeout] = v }
        opts.on("--arbiter-rounds N", Integer) { |v| @options[:arbiter_rounds] = v }
      end.parse!(@argv)
    end

    def print_help
      puts <<~HELP
        Usage: prr [PR_URL | setup] [options]

        Commands:
          setup                      Interactive configuration wizard

        Arguments:
          PR_URL                     GitHub PR URL (e.g., https://github.com/org/repo/pull/123)
                                     If omitted, lists PRs pending your review.

        Options:
          --ticket TICKET            Jira ticket ID (e.g., PROJ-456). Auto-detected if omitted.
          --arbiter-only             Re-run arbiter on existing review results. Skip agent phase.
          --comments PATH            Post review from an edited final-report.md file.
          --claude-timeout SECONDS   Timeout for Claude agent (default: 600)
          --codex-timeout SECONDS    Timeout for Codex agent (default: 900)
          --arbiter-rounds N         Max arbiter Q&A rounds (default: 3)
          --help                     Show this help message.

        Examples:
          prr setup                                        # Run interactive config wizard
          prr                                              # List PRs pending your review
          prr https://github.com/org/repo/pull/123         # Review a specific PR
          prr https://github.com/org/repo/pull/123 --ticket PROJ-456
          prr https://github.com/org/repo/pull/123 --arbiter-only
          prr --comments path/to/final-report.md           # Post from edited report

        Workflow:
          1. prr <PR_URL>                    # Run review, get final-report.md
          2. Edit final-report.md            # Check line comments, edit questions
          3. prr --comments final-report.md  # Post to GitHub
      HELP
    end
  end
end

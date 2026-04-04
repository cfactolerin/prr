# frozen_string_literal: true

require "json"
require "open3"
require "fileutils"
require "prr/config"
require "prr/progress"
require "prr/report"
require "prr/preflight"

module Prr
  class GithubCommenter
    GH_ENV = { "NO_COLOR" => "1" }.freeze
    ANSI_PATTERN = /\e\[[0-9;]*m/

    REVIEW_EVENT_MAP = {
      "Comment" => "COMMENT",
      "Approve" => "APPROVE",
      "Request Changes" => "REQUEST_CHANGES"
    }.freeze

    def self.run_from_file(report_path, options)
      config = Config.load(options)

      Progress.abort("Report file not found: #{report_path}") unless File.exist?(report_path)

      report = Report.from_edited_file(report_path)

      # Extract PR info from report content
      pr_url = extract_pr_url(report.content)
      Progress.abort("Could not find PR URL in report.") unless pr_url

      match = pr_url.match(Preflight::PR_URL_PATTERN)
      Progress.abort("Invalid PR URL in report: #{pr_url}") unless match

      new(config, match[1], match[2], match[3].to_i, report).run!
    end

    def initialize(config, owner, repo, pr_number, report)
      @config = config
      @owner = owner
      @repo = repo
      @pr_number = pr_number
      @report = report
    end

    def run!
      comments = @report.checked_comments
      review_body = @report.review_body
      review_action = @report.review_action

      if comments.empty? && review_body.nil?
        puts "No checked comments and no review body. Nothing to post."
        return
      end

      # Show what will be posted
      puts
      if comments.any?
        Progress.log("#{comments.length} line comment(s) selected:")
        comments.each { |c| Progress.indent("#{c[:path]}#L#{c[:line]} — #{c[:body]}") }
      end

      if review_body
        puts
        Progress.log("Review action: #{review_action || "Comment"}")
        Progress.log("Review body preview:")
        review_body.lines.first(5).each { |l| Progress.indent(l.chomp) }
        Progress.indent("...") if review_body.lines.length > 5
      end

      puts
      print "Post to GitHub? (y/N): "
      choice = $stdin.gets&.strip&.downcase
      return unless choice == "y"

      post_review!(comments, review_body, review_action)
    end

    private

    def self.extract_pr_url(content)
      # Try table format: | **PR** | <url> |
      match = content.match(/\|\s*\*\*PR\*\*\s*\|\s*(https:\/\/[^\s|]+)/)
      return match[1].strip if match

      # Try header format: PR: <url>
      match = content.match(/^PR:\s*(https:\/\/\S+)/)
      return match[1].strip if match

      nil
    end

    def post_review!(comments, review_body, review_action)
      Progress.log("Posting review to GitHub...")

      sha, err, status = Open3.capture3(
        GH_ENV,
        "gh", "pr", "view", @pr_number.to_s,
        "--repo", "#{@owner}/#{@repo}",
        "--json", "headRefOid",
        "--jq", ".headRefOid"
      )
      Progress.abort("Failed to get PR head SHA: #{err}") unless status.success?
      sha = sha.gsub(ANSI_PATTERN, "").strip

      event = REVIEW_EVENT_MAP[review_action] || "COMMENT"

      body = { commit_id: sha, event: event }
      body[:body] = review_body if review_body && !review_body.empty?

      if comments.any?
        body[:comments] = comments.map do |c|
          { path: c[:path], line: c[:line], body: c[:body] }
        end
      end

      json_path = File.join(File.dirname(__FILE__), "../../tmp/review-payload.json")
      FileUtils.mkdir_p(File.dirname(json_path))
      File.write(json_path, JSON.pretty_generate(body))

      output, err, status = Open3.capture3(
        GH_ENV,
        "gh", "api",
        "repos/#{@owner}/#{@repo}/pulls/#{@pr_number}/reviews",
        "--input", json_path
      )

      if status.success?
        Progress.done("Review posted to GitHub!")
        Progress.indent("Action: #{event}")
        Progress.indent("Comments: #{comments.length}") if comments.any?
      else
        Progress.error("Failed to post review: #{err.empty? ? output : err}")
      end
    ensure
      FileUtils.rm_f(json_path) if json_path
    end
  end
end

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
    REVIEW_STATUS_MAP = {
      "APPROVE" => "APPROVE",
      "REQUEST_CHANGES" => "REQUEST_CHANGES",
      "NEEDS_DISCUSSION" => "COMMENT"
    }.freeze

    def self.run_from_latest(options)
      config = Config.load(options)
      pr_url = options[:pr_url]
      Progress.abort("PR URL required for --comments") unless pr_url

      match = pr_url.match(Preflight::PR_URL_PATTERN)
      Progress.abort("Invalid PR URL") unless match

      repo = match[2]
      pr_number = match[3].to_i
      review_dir = File.join(config.tmp_path, "#{repo}-pr-#{pr_number}", "results")

      Progress.abort("No previous reviews found.") unless Dir.exist?(review_dir)

      latest = Dir.children(review_dir).sort.last
      report_path = File.join(review_dir, latest, "final-report.md")
      Progress.abort("No final report found.") unless File.exist?(report_path)

      report = Report.new(File.read(report_path))
      new(config, match[1], repo, pr_number, report).run!
    end

    def initialize(config, owner, repo, pr_number, report)
      @config = config
      @owner = owner
      @repo = repo
      @pr_number = pr_number
      @report = report
    end

    def run!
      comments = @report.line_comments
      if comments.empty?
        puts "No line comments to post."
        return
      end

      puts
      puts "#{comments.length} line comment(s) ready."
      puts
      comments.each_with_index do |c, i|
        puts "  #{i + 1}. #{c[:path]}:#{c[:line]} — #{c[:body]}"
      end
      puts
      print "Post to GitHub? (a)ll / (s)elect / (e)dit / (n)one: "
      choice = $stdin.gets&.strip&.downcase

      selected = case choice
                 when "a" then comments
                 when "s" then select_comments(comments)
                 when "e" then edit_comments(comments)
                 when "n" then return
                 else
                   puts "Invalid choice."
                   return
                 end

      post_review!(selected)
    end

    private

    def select_comments(comments)
      print "Enter numbers (e.g., 1,3,5): "
      input = $stdin.gets&.strip || ""
      indices = input.split(",").map { |s| s.strip.to_i - 1 }
      indices.filter_map { |i| comments[i] if i >= 0 && i < comments.length }
    end

    def edit_comments(comments)
      editor = ENV["EDITOR"] || "vim"
      comments.map do |c|
        tmp = File.join(@config.tmp_path, "comment-edit.tmp")
        File.write(tmp, "#{c[:path]}:#{c[:line]}\n\n#{c[:body]}")
        system("#{editor} #{tmp}")
        content = File.read(tmp)
        lines = content.split("\n", 2)
        loc = lines[0]
        body = lines[1]&.strip || c[:body]
        path, line = loc.split(":")
        { path: path, line: line.to_i, body: body }
      end
    end

    GH_ENV = { "NO_COLOR" => "1" }.freeze
    ANSI_PATTERN = /\e\[[0-9;]*m/

    def post_review!(comments)
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

      review_event = REVIEW_STATUS_MAP[@report.verdict] || "COMMENT"

      body = {
        commit_id: sha,
        event: review_event,
        body: "PRR Review — Verdict: #{@report.verdict} (#{@report.confidence} confidence)",
        comments: comments.map do |c|
          { path: c[:path], line: c[:line], body: c[:body] }
        end
      }

      json_path = File.join(@config.tmp_path, "review-payload.json")
      File.write(json_path, JSON.pretty_generate(body))

      output, err, status = Open3.capture3(
        GH_ENV,
        "gh", "api",
        "repos/#{@owner}/#{@repo}/pulls/#{@pr_number}/reviews",
        "--input", json_path
      )

      if status.success?
        Progress.done("Review posted to GitHub!")
      else
        Progress.error("Failed to post review: #{output}")
      end
    ensure
      FileUtils.rm_f(json_path) if json_path
    end
  end
end

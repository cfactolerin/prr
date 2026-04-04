# frozen_string_literal: true

require "fileutils"
require "open3"
require "prr/progress"

module Prr
  class Sandbox
    attr_reader :repo_path, :results_path, :timestamp

    def initialize(config, owner, repo, pr_number)
      @config = config
      @repo = repo
      @pr_number = pr_number
      @timestamp = Time.now.strftime("%Y-%m-%d-%H%M%S")
      @review_dir = File.join(@config.tmp_path, "#{@repo}-pr-#{@pr_number}")
      @repo_path = File.join(@review_dir, "repo")
      @results_path = File.join(@review_dir, "results", @timestamp)
    end

    def setup!
      source = File.join(@config.base_repo_path, @repo)
      Progress.abort("Repo not found locally: #{source}") unless Dir.exist?(source)

      Progress.log("Copying #{@repo} to sandbox...")
      FileUtils.mkdir_p(@review_dir)
      FileUtils.rm_rf(@repo_path) if Dir.exist?(@repo_path)
      FileUtils.cp_r(source, @repo_path)

      Progress.log("Checking out PR branch...")
      git!("fetch origin pull/#{@pr_number}/head:pr-review")
      git!("checkout pr-review")

      FileUtils.mkdir_p(@results_path)
      Progress.log("Sandbox ready.")
    end

    def cleanup!
      Progress.log("Cleaning up sandbox...")
      FileUtils.rm_rf(@repo_path)
      Progress.log("Sandbox removed. Results: #{@results_path}")
    end

    def previous_review_path
      results_dir = File.join(@review_dir, "results")
      return nil unless Dir.exist?(results_dir)

      latest = Dir.children(results_dir)
                  .select { |d| d != @timestamp }
                  .sort
                  .last
      return nil unless latest

      path = File.join(results_dir, latest, "final-report.md")
      File.exist?(path) ? path : nil
    end

    def diff(base_branch)
      # Try base branch directly, then origin/<base>
      # Use git_silent to suppress "fatal:" noise on failed candidates
      candidates = [base_branch, "origin/#{base_branch}"]
      candidates.each do |ref|
        output = git_silent("diff", "#{ref}..pr-review", "--")
        return output if output

        # Try merge-base approach
        mb = git_silent("merge-base", ref, "pr-review")
        if mb
          output = git_silent("diff", "#{mb.strip}..pr-review", "--")
          return output if output
        end
      end

      Progress.error("Could not compute diff against #{base_branch}. Agents will review without diff.")
      ""
    end

    def read_repo_file(relative_path)
      path = File.join(@repo_path, relative_path)
      File.exist?(path) ? File.read(path) : nil
    end

    private

    def git!(args)
      cmd = "git -C #{@repo_path} #{args}"
      output, status = Open3.capture2(cmd)
      Progress.abort("Git failed: #{cmd}\n#{output}") unless status.success?
      output
    end

    # Run git command silently — returns output on success, nil on failure
    def git_silent(*args)
      output, _, status = Open3.capture3("git", "-C", @repo_path, *args)
      status.success? && !output.strip.empty? ? output : nil
    end
  end
end

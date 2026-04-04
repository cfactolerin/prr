# frozen_string_literal: true

require "json"
require "open3"
require "net/http"
require "uri"
require "base64"
require "prr/progress"

module Prr
  class Preflight
    PR_URL_PATTERN = %r{github\.com/([^/]+)/([^/]+)/pull/(\d+)}
    TICKET_PATTERN = /([A-Z][A-Z0-9]+-\d+)/

    attr_reader :owner, :repo, :pr_number, :pr_data, :ticket_id, :ticket_data

    def initialize(config, options)
      @config = config
      @options = options
    end

    def run!
      check_disk_space!
      resolve_pr!
      fetch_pr_metadata!
      resolve_ticket!
      fetch_ticket_details!
      self
    end

    private

    def check_disk_space!
      Progress.log("Checking disk space...")
      output, = Open3.capture2("df -g #{@config.tmp_path}")
      lines = output.strip.split("\n")
      free_gb = lines.last.split[3].to_i

      if free_gb < @config.min_disk_space_gb
        Progress.abort("Only #{free_gb}GB free. Need at least #{@config.min_disk_space_gb}GB. Free up space and retry.")
      end

      Progress.log("Checking disk space... #{free_gb}GB free ✓")
    end

    def resolve_pr!
      if @options[:pr_url]
        match = @options[:pr_url].match(PR_URL_PATTERN)
        Progress.abort("Invalid PR URL: #{@options[:pr_url]}") unless match
        @owner, @repo, @pr_number = match[1], match[2], match[3].to_i
      else
        pick_pending_pr!
      end
    end

    def pick_pending_pr!
      Progress.log("Fetching PRs pending your review...")
      user = @config.github_user
      Progress.abort("GitHub user not configured. Run 'prr setup' first.") if user.empty?

      cmd = "gh search prs --review-requested=#{user} --state=open --json repository,number,title,url --limit 20"
      output, status = Open3.capture2(cmd)
      Progress.abort("Failed to fetch PRs: #{output}") unless status.success?

      prs = JSON.parse(output)
      if prs.empty?
        puts "No PRs pending your review."
        exit 0
      end

      puts
      prs.each_with_index do |pr, i|
        repo_name = pr.dig("repository", "nameWithOwner") || pr.dig("repository", "name") || "unknown"
        puts "  #{i + 1}. [#{repo_name}] ##{pr["number"]} — #{pr["title"]}"
      end
      puts
      print "Select PR (1-#{prs.length}): "
      choice = $stdin.gets&.strip&.to_i
      Progress.abort("Invalid selection.") unless choice && choice >= 1 && choice <= prs.length

      url = prs[choice - 1]["url"]
      match = url.match(PR_URL_PATTERN)
      Progress.abort("Could not parse PR URL: #{url}") unless match
      @owner, @repo, @pr_number = match[1], match[2], match[3].to_i
    end

    def fetch_pr_metadata!
      Progress.log("Fetching PR ##{@pr_number} metadata...")
      fields = "number,title,body,headRefName,baseRefName,author,files,url,commits"
      cmd = "gh pr view #{@pr_number} --repo #{@owner}/#{@repo} --json #{fields}"
      output, status = Open3.capture2(cmd)
      Progress.abort("Failed to fetch PR metadata: #{output}") unless status.success?

      @pr_data = JSON.parse(output)
      Progress.log("PR: #{@pr_data["title"]}")
    end

    def resolve_ticket!
      if @options[:ticket]
        @ticket_id = @options[:ticket]
        return
      end

      sources = [@pr_data["title"], @pr_data["body"], @pr_data["headRefName"]].compact.join(" ")
      match = sources.match(TICKET_PATTERN)

      if match
        @ticket_id = match[1]
        Progress.log("Jira ticket detected: #{@ticket_id}")
      else
        print "Could not detect Jira ticket. Enter ticket ID (or press enter to skip): "
        input = $stdin.gets&.strip
        @ticket_id = input unless input.nil? || input.empty?
      end
    end

    def fetch_ticket_details!
      return unless @ticket_id

      base_url = @config.jira_base_url
      token = @config.jira_api_token
      email = @config.jira_email

      if [base_url, token, email].any? { |v| v.nil? || v.empty? }
        Progress.log("Jira not configured — skipping ticket fetch.")
        @ticket_data = nil
        return
      end

      Progress.log("Fetching Jira ticket #{@ticket_id}...")
      uri = URI("#{base_url}/rest/api/3/issue/#{@ticket_id}")
      req = Net::HTTP::Get.new(uri)
      req["Authorization"] = "Basic #{Base64.strict_encode64("#{email}:#{token}")}"
      req["Accept"] = "application/json"

      resp = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https") { |h| h.request(req) }

      if resp.code == "200"
        @ticket_data = JSON.parse(resp.body)
        summary = @ticket_data.dig("fields", "summary") || "No summary"
        Progress.log("Jira ticket: #{@ticket_id} — \"#{summary}\"")
      else
        Progress.error("Jira API returned #{resp.code}. Continuing without ticket details.")
        @ticket_data = nil
      end
    rescue StandardError => e
      Progress.error("Jira fetch failed: #{e.message}. Continuing without ticket details.")
      @ticket_data = nil
    end
  end
end

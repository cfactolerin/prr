# frozen_string_literal: true

require "json"
require "net/http"
require "uri"
require "base64"
require "fileutils"
require "prr/progress"

module Prr
  class TicketFetcher
    CONFLUENCE_URL_PATTERN = %r{https?://[^/]*atlassian\.net/wiki/spaces/[^\s)\]]+}
    CONFLUENCE_PAGE_ID_PATTERN = %r{/pages/(\d+)}
    EXTERNAL_URL_PATTERN = %r{https?://[^\s)\]>"]+}

    attr_reader :ticket_context_path

    def initialize(config:, ticket_id:, results_path:)
      @config = config
      @ticket_id = ticket_id
      @results_path = results_path
      @ticket_dir = File.join(results_path, "ticket")
      @attachments_dir = File.join(@ticket_dir, "attachments")
      @confluence_dir = File.join(@ticket_dir, "confluence")
      @ticket_context_path = File.join(@ticket_dir, "ticket-context.md")
    end

    def fetch!
      return nil unless @ticket_id

      base_url = @config.jira_base_url
      token = @config.jira_api_token
      email = @config.jira_email

      if [base_url, token, email].any? { |v| v.nil? || v.empty? }
        Progress.log("Jira not configured — skipping ticket fetch.")
        return nil
      end

      FileUtils.mkdir_p(@ticket_dir)

      Progress.log("Fetching Jira ticket #{@ticket_id}...")
      ticket = fetch_ticket
      return nil unless ticket

      summary = ticket.dig("fields", "summary") || "No summary"
      Progress.log("Jira ticket: #{@ticket_id} — \"#{summary}\"")

      # Extract all text content for link discovery
      description = extract_text(ticket.dig("fields", "description"))
      comments = fetch_comments(ticket)
      acceptance_criteria = extract_acceptance_criteria(ticket)
      all_text = [description, comments.map { |c| c[:body] }, acceptance_criteria].flatten.compact.join("\n")

      # Download attachments
      attachments = download_attachments(ticket)

      # Find and fetch Confluence pages
      confluence_links = all_text.scan(CONFLUENCE_URL_PATTERN).uniq
      confluence_pages = fetch_confluence_pages(confluence_links)

      # Build consolidated context file
      build_context_file(
        ticket: ticket,
        description: description,
        acceptance_criteria: acceptance_criteria,
        comments: comments,
        attachments: attachments,
        confluence_pages: confluence_pages
      )

      Progress.log("Ticket context saved: #{@ticket_context_path}")
      @ticket_context_path
    end

    private

    def fetch_ticket
      data = jira_get("/rest/api/3/issue/#{@ticket_id}?expand=renderedFields")
      return nil unless data

      data
    rescue StandardError => e
      Progress.error("Jira ticket fetch failed: #{e.message}")
      nil
    end

    def fetch_comments(ticket)
      raw_comments = ticket.dig("fields", "comment", "comments") || []
      raw_comments.map do |c|
        {
          author: c.dig("author", "displayName") || "unknown",
          created: c["created"],
          body: extract_text(c["body"])
        }
      end
    end

    def extract_acceptance_criteria(ticket)
      # Common custom field names for acceptance criteria
      fields = ticket["fields"] || {}
      ac = fields["customfield_10020"] || # common Jira AC field
           fields["customfield_10024"] ||
           fields.find { |k, _| k.is_a?(String) && fields[k].is_a?(String) && fields[k].downcase.include?("acceptance") }&.last

      extract_text(ac) if ac
    end

    def download_attachments(ticket)
      jira_attachments = ticket.dig("fields", "attachment") || []
      return [] if jira_attachments.empty?

      FileUtils.mkdir_p(@attachments_dir)
      Progress.log("Downloading #{jira_attachments.length} attachment(s)...")

      jira_attachments.filter_map do |att|
        filename = att["filename"]
        url = att["content"]
        size = att["size"].to_i
        mime = att["mimeType"] || ""

        # Skip very large files (>10MB) or binary formats that agents can't read
        if size > 10_000_000
          Progress.indent("Skipping #{filename} (#{size / 1_000_000}MB, too large)")
          next { filename: filename, path: nil, note: "Skipped: too large (#{size / 1_000_000}MB)" }
        end

        local_path = File.join(@attachments_dir, filename)
        begin
          download_file(url, local_path)
          relative = "attachments/#{filename}"
          Progress.indent("Downloaded: #{filename}")
          { filename: filename, path: relative, mime: mime, size: size }
        rescue StandardError => e
          Progress.indent("Failed to download #{filename}: #{e.message}")
          { filename: filename, path: nil, note: "Download failed: #{e.message}" }
        end
      end
    end

    def fetch_confluence_pages(urls)
      return [] if urls.empty?

      FileUtils.mkdir_p(@confluence_dir)
      Progress.log("Fetching #{urls.length} linked Confluence page(s)...")

      urls.filter_map do |url|
        page_id = url.match(CONFLUENCE_PAGE_ID_PATTERN)&.captures&.first
        next unless page_id

        begin
          data = confluence_get("/wiki/api/v2/pages/#{page_id}?body-format=storage")
          next unless data

          title = data["title"] || "Page #{page_id}"
          body_html = data.dig("body", "storage", "value") || ""
          # Convert basic HTML to readable text
          body_text = html_to_text(body_html)

          filename = "page-#{page_id}.md"
          local_path = File.join(@confluence_dir, filename)
          File.write(local_path, "# #{title}\n\n#{body_text}")

          Progress.indent("Fetched: #{title}")
          { title: title, url: url, path: "confluence/#{filename}" }
        rescue StandardError => e
          Progress.indent("Failed to fetch Confluence page #{page_id}: #{e.message}")
          { title: "Page #{page_id}", url: url, path: nil, note: "Fetch failed: #{e.message}" }
        end
      end
    end

    def build_context_file(ticket:, description:, acceptance_criteria:, comments:, attachments:, confluence_pages:)
      summary = ticket.dig("fields", "summary") || "No summary"
      status = ticket.dig("fields", "status", "name") || "Unknown"
      issue_type = ticket.dig("fields", "issuetype", "name") || "Unknown"
      priority = ticket.dig("fields", "priority", "name") || "Unknown"
      assignee = ticket.dig("fields", "assignee", "displayName") || "Unassigned"
      labels = (ticket.dig("fields", "labels") || []).join(", ")

      lines = []
      lines << "# #{@ticket_id}: #{summary}"
      lines << ""
      lines << "- **Type:** #{issue_type}"
      lines << "- **Status:** #{status}"
      lines << "- **Priority:** #{priority}"
      lines << "- **Assignee:** #{assignee}"
      lines << "- **Labels:** #{labels}" unless labels.empty?
      lines << ""

      lines << "## Description"
      lines << ""
      lines << (description || "No description.")
      lines << ""

      if acceptance_criteria
        lines << "## Acceptance Criteria"
        lines << ""
        lines << acceptance_criteria
        lines << ""
      end

      if attachments.any?
        lines << "## Attachments"
        lines << ""
        attachments.each do |att|
          if att[:path]
            lines << "- [#{att[:filename]}](#{att[:path]}) (#{format_size(att[:size])})"
          else
            lines << "- #{att[:filename]} — #{att[:note]}"
          end
        end
        lines << ""
      end

      if confluence_pages.any?
        lines << "## Linked Confluence Pages"
        lines << ""
        confluence_pages.each do |page|
          if page[:path]
            lines << "- [#{page[:title]}](#{page[:path]})"
          else
            lines << "- #{page[:title]} (#{page[:url]}) — #{page[:note]}"
          end
        end
        lines << ""
      end

      if comments.any?
        lines << "## Comments"
        lines << ""
        comments.each do |c|
          date = c[:created]&.slice(0, 10) || "unknown date"
          lines << "### #{c[:author]} (#{date})"
          lines << ""
          lines << c[:body]
          lines << ""
        end
      end

      File.write(@ticket_context_path, lines.join("\n"))
    end

    # --- HTTP helpers ---

    def jira_get(path)
      uri = URI("#{@config.jira_base_url}#{path}")
      req = Net::HTTP::Get.new(uri)
      req["Authorization"] = auth_header
      req["Accept"] = "application/json"

      resp = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https") { |h| h.request(req) }
      resp.code == "200" ? JSON.parse(resp.body) : nil
    end

    def confluence_get(path)
      uri = URI("#{@config.jira_base_url}#{path}")
      req = Net::HTTP::Get.new(uri)
      req["Authorization"] = auth_header
      req["Accept"] = "application/json"

      resp = Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https") { |h| h.request(req) }
      resp.code == "200" ? JSON.parse(resp.body) : nil
    end

    def download_file(url, local_path)
      uri = URI(url)
      req = Net::HTTP::Get.new(uri)
      req["Authorization"] = auth_header

      Net::HTTP.start(uri.hostname, uri.port, use_ssl: uri.scheme == "https") do |http|
        http.request(req) do |resp|
          File.open(local_path, "wb") { |f| resp.read_body { |chunk| f.write(chunk) } }
        end
      end
    end

    def auth_header
      "Basic #{Base64.strict_encode64("#{@config.jira_email}:#{@config.jira_api_token}")}"
    end

    def html_to_text(html)
      text = html.dup
      text.gsub!(/<br\s*\/?>/, "\n")
      text.gsub!(/<\/p>/, "\n\n")
      text.gsub!(/<\/li>/, "\n")
      text.gsub!(/<li>/, "- ")
      text.gsub!(/<h[1-6][^>]*>/, "\n### ")
      text.gsub!(/<\/h[1-6]>/, "\n")
      text.gsub!(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/) { "[#{$2}](#{$1})" }
      text.gsub!(/<code>([^<]*)<\/code>/) { "`#{$1}`" }
      text.gsub!(/<[^>]+>/, "")
      text.gsub!(/&amp;/, "&")
      text.gsub!(/&lt;/, "<")
      text.gsub!(/&gt;/, ">")
      text.gsub!(/&quot;/, '"')
      text.gsub!(/&#39;/, "'")
      text.gsub!(/\n{3,}/, "\n\n")
      text.strip
    end

    def extract_text(field)
      return nil if field.nil?
      return field if field.is_a?(String)

      # Jira API v3 uses Atlassian Document Format (ADF)
      return extract_adf_text(field) if field.is_a?(Hash) && field["type"] == "doc"

      field.to_s
    end

    def extract_adf_text(node)
      return "" unless node.is_a?(Hash)

      case node["type"]
      when "text"
        node["text"] || ""
      when "hardBreak"
        "\n"
      when "paragraph"
        children_text(node) + "\n\n"
      when "heading"
        level = node.dig("attrs", "level") || 3
        "#{"#" * level} #{children_text(node)}\n\n"
      when "bulletList"
        (node["content"] || []).map { |item| "- #{children_text(item).strip}" }.join("\n") + "\n\n"
      when "orderedList"
        (node["content"] || []).each_with_index.map { |item, i| "#{i + 1}. #{children_text(item).strip}" }.join("\n") + "\n\n"
      when "codeBlock"
        lang = node.dig("attrs", "language") || ""
        "```#{lang}\n#{children_text(node)}```\n\n"
      when "inlineCard", "blockCard"
        url = node.dig("attrs", "url") || ""
        url.empty? ? "" : "[#{url}](#{url})"
      else
        children_text(node)
      end
    end

    def children_text(node)
      (node["content"] || []).map { |child| extract_adf_text(child) }.join
    end

    def format_size(bytes)
      return "0B" unless bytes

      if bytes < 1024
        "#{bytes}B"
      elsif bytes < 1_048_576
        "#{bytes / 1024}KB"
      else
        "#{bytes / 1_048_576}MB"
      end
    end
  end
end

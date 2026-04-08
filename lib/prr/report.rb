# frozen_string_literal: true

module Prr
  class Report
    # Table row: | [ ] | [path#L42](url) | message |
    # or:        | [x] | [path#L42](url) | message |
    TABLE_COMMENT_PATTERN = /^\|\s*\[([xX ])\]\s*\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(.+?)\s*\|$/
    REVIEW_ACTION_PATTERN = /^-\s*\[([xX])\]\s*(Comment|Approve|Request Changes)\s*$/i

    attr_reader :content, :verdict, :confidence, :line_comments, :review_action, :review_body

    def initialize(content)
      @content = strip_code_fence(content)
      parse!
    end

    def save!(results_path)
      path = File.join(results_path, "final-report.md")
      File.write(path, format_for_reading(@content))
      path
    end

    # Parse an edited report file for posting
    def self.from_edited_file(path)
      new(File.read(path))
    end

    # Return only checked line comments
    def checked_comments
      @line_comments.select { |c| c[:checked] }
    end

    private

    def strip_code_fence(text)
      text.gsub(/\A\s*```\w*\n/, "").gsub(/\n```\s*\z/, "")
    end

    def parse!
      @verdict = extract_field("Verdict") || "UNKNOWN"
      @confidence = extract_field("Verdict Confidence") || extract_field("Confidence") || "UNKNOWN"
      @line_comments = extract_table_comments
      @review_action = extract_review_action
      @review_body = extract_review_body
    end

    def extract_field(name)
      match = @content.match(/##\s*#{name}:\s*(.+)/)
      match ? match[1].strip : nil
    end

    def extract_table_comments
      in_section = false
      comments = []

      @content.each_line do |line|
        if line.match?(/^##\s*Line Comments/)
          in_section = true
          next
        elsif line.match?(/^##\s/) && in_section
          break
        end

        next unless in_section

        match = line.match(TABLE_COMMENT_PATTERN)
        if match
          checked = match[1].strip.downcase == "x"
          display = match[2]  # e.g., "path/to/file.rb#L42"
          url = match[3]
          body = match[4].strip

          # Extract path and line from display text like "path/to/file.rb#L42"
          # The commenter resolves partial paths against the PR's file list.
          if display.match?(/(.+)#L(\d+)/)
            file_match = display.match(/(.+)#L(\d+)/)
            path = file_match[1].delete("`")
            line_num = file_match[2].to_i
          else
            path = display.delete("`")
            line_num = 0
          end

          comments << { checked: checked, path: path, line: line_num, url: url, body: body }
        end

        # Also support old format for backwards compat
        old_match = line.match(/^-\s*`([^`]+?):(\d+)`\s*[—–-]\s*(.+)$/)
        if old_match && !match
          comments << { checked: true, path: old_match[1], line: old_match[2].to_i, url: nil, body: old_match[3].strip }
        end
      end

      comments
    end

    def extract_review_action
      in_section = false
      @content.each_line do |line|
        if line.match?(/^###\s*Review Action/)
          in_section = true
          next
        elsif line.match?(/^##/) && in_section
          break
        end

        if in_section
          match = line.match(REVIEW_ACTION_PATTERN)
          return match[2].strip if match
        end
      end
      nil
    end

    def extract_review_body
      in_body = false
      lines = []

      @content.each_line do |line|
        if line.match?(/^###\s*Comment Body/)
          in_body = true
          next
        elsif line.match?(/^##/) && in_body
          break
        end

        lines << line if in_body
      end

      body = lines.join.strip
      body.empty? ? nil : body
    end

    # --- Formatting ---

    def format_for_reading(text)
      lines = []
      text.each_line do |line|
        stripped = line.chomp
        if preserve_line?(stripped)
          lines << stripped
        elsif stripped.start_with?("- ")
          lines.concat(word_wrap(stripped, 80, indent: "  "))
        elsif stripped.match?(/^\d+\.\s/)
          lines.concat(word_wrap(stripped, 80, indent: "   "))
        else
          lines.concat(word_wrap(stripped, 80))
        end
      end
      lines.join("\n") + "\n"
    end

    def preserve_line?(line)
      line.empty? ||
        line.start_with?("#") ||
        (line.start_with?("- ") && line.length <= 80) ||
        line.start_with?("  ") ||
        line.start_with?("|") ||
        line.start_with?("```") ||
        line.start_with?("---") ||
        line.start_with?("<!--") ||
        (line.match?(/^\d+\.\s/) && line.length <= 80) ||
        line.match?(/^\*\*[^*]+:\*\*/) ||
        line.length <= 80
    end

    def word_wrap(text, width, indent: "")
      return [text] if text.length <= width

      wrapped = []
      current = +""

      text.split(/\s+/).each do |word|
        if current.empty?
          current = word
        elsif current.length + 1 + word.length > width
          wrapped << current
          current = indent + word
        else
          current << " " << word
        end
      end
      wrapped << current unless current.empty?
      wrapped
    end
  end
end

# frozen_string_literal: true

module Prr
  class Report
    LINE_COMMENT_PATTERN = /^-\s*`([^`]+?):(\d+)`\s*[—–-]\s*(.+)$/

    attr_reader :content, :verdict, :confidence, :line_comments

    def initialize(content)
      @content = strip_code_fence(content)
      parse!
    end

    def save!(results_path)
      path = File.join(results_path, "final-report.md")
      File.write(path, @content)
      path
    end

    private

    def strip_code_fence(text)
      # Arbiter sometimes wraps the report in ```...``` — strip it
      stripped = text.gsub(/\A\s*```\w*\n/, "").gsub(/\n```\s*\z/, "")
      stripped
    end

    def parse!
      @verdict = extract_field("Verdict") || "UNKNOWN"
      @confidence = extract_field("Confidence") || "UNKNOWN"
      @line_comments = extract_line_comments
    end

    def extract_field(name)
      match = @content.match(/##\s*#{name}:\s*(.+)/)
      match ? match[1].strip : nil
    end

    def extract_line_comments
      in_section = false
      comments = []

      @content.each_line do |line|
        if line.match?(/^##\s*Line Comments/)
          in_section = true
          next
        elsif line.match?(/^##\s/) && in_section
          break
        end

        if in_section
          match = line.match(LINE_COMMENT_PATTERN)
          if match
            comments << { path: match[1], line: match[2].to_i, body: match[3].strip }
          end
        end
      end

      comments
    end
  end
end

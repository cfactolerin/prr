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
      File.write(path, format_for_reading(@content))
      path
    end

    private

    def strip_code_fence(text)
      text.gsub(/\A\s*```\w*\n/, "").gsub(/\n```\s*\z/, "")
    end

    def format_for_reading(text)
      lines = []
      text.each_line do |line|
        stripped = line.chomp
        if preserve_line?(stripped)
          lines << stripped
        elsif stripped.start_with?("- ")
          # Wrap list items with hanging indent
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
        line.start_with?("#") ||          # headings
        (line.start_with?("- ") && line.length <= 80) || # short list items
        line.start_with?("  ") ||         # indented/nested content
        line.start_with?("|") ||          # tables
        line.start_with?("```") ||        # code fences
        line.start_with?("---") ||        # horizontal rules
        (line.match?(/^\d+\.\s/) && line.length <= 80) || # short numbered items
        line.match?(/^\*\*[^*]+:\*\*/) ||  # bold labels like **Key:** value
        line.length <= 80                  # already short enough
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

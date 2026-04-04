# frozen_string_literal: true

require "open3"
require "prr/progress"

module Prr
  class AgentRunner
    def initialize(config:, sandbox:, results_path:)
      @config = config
      @sandbox = sandbox
      @results_path = results_path
    end

    def run_parallel_review!(prompt)
      claude_prompt_path = File.join(@results_path, "claude-prompt.md")
      codex_prompt_path = File.join(@results_path, "codex-prompt.md")
      File.write(claude_prompt_path, prompt)
      File.write(codex_prompt_path, prompt)

      claude_result_path = File.join(@results_path, "claude-review.md")
      codex_result_path = File.join(@results_path, "codex-review.md")

      prompt_size = prompt.bytesize
      Progress.log("Starting parallel review... (prompt: #{format_bytes(prompt_size)})")
      Progress.indent("Claude: running (timeout: #{format_duration(@config.claude_timeout)})")
      Progress.indent("Codex:  running (timeout: #{format_duration(@config.codex_timeout)})")

      threads = []
      threads << Thread.new { run_claude(prompt, claude_result_path, @config.claude_timeout) }
      threads << Thread.new { run_codex(prompt, codex_result_path, @config.codex_timeout, writable: true) }
      threads.each(&:join)

      {
        claude: File.exist?(claude_result_path) ? File.read(claude_result_path) : "",
        codex: File.exist?(codex_result_path) ? File.read(codex_result_path) : ""
      }
    end

    def run_agent(agent, prompt_text, output_path, timeout, writable: false)
      case agent
      when :claude then run_claude(prompt_text, output_path, timeout)
      when :codex then run_codex(prompt_text, output_path, timeout, writable: writable)
      end
    end

    private

    def run_claude(prompt_text, output_path, timeout_secs)
      start = Time.now
      cmd = ["claude", "-p", "--dangerously-skip-permissions", "--output-format", "text"]

      run_with_timeout(cmd, prompt_text, output_path, timeout_secs, "Claude", start) do |stdout_data|
        # Claude -p writes to stdout
        File.write(output_path, stdout_data)
      end
    end

    def run_codex(prompt_text, output_path, timeout_secs, writable: false)
      start = Time.now
      sandbox_mode = writable ? "workspace-write" : "read-only"
      cmd = [
        "codex", "-a", "never", "exec",
        "-C", @sandbox.repo_path,
        "-s", sandbox_mode,
        "--add-dir", @results_path,
        "--ephemeral",
        "--color", "never",
        "--output-last-message", output_path,
        "-"
      ]

      run_with_timeout(cmd, prompt_text, output_path, timeout_secs, "Codex", start)
      # Codex writes to output_path via --output-last-message flag
    end

    def run_with_timeout(cmd, prompt_text, output_path, timeout_secs, label, start)
      pid = nil
      stdout_data = +""
      stderr_data = +""
      begin
        stdin, stdout, stderr, wait_thread = Open3.popen3(*cmd, chdir: @sandbox.repo_path)
        pid = wait_thread.pid
        stdout_reader = Thread.new { stdout.read }
        stderr_reader = Thread.new { stderr.read }

        stdin.write(prompt_text)
        stdin.close

        unless wait_thread.join(timeout_secs)
          Process.kill("TERM", pid)
          wait_thread.join(5) || Process.kill("KILL", pid)
          stdout_data = stdout_reader.value.to_s
          stderr_data = stderr_reader.value.to_s
          elapsed = format_duration((Time.now - start).to_i)
          Progress.indent("#{label}: TIMEOUT after #{elapsed}")
          partial = [stdout_data, stderr_data].reject(&:empty?).join("\n")
          File.write(output_path, "# PARTIAL REVIEW (timeout after #{elapsed})\n\n#{partial}") unless File.exist?(output_path)
          return
        end

        stdout_data = stdout_reader.value.to_s
        stderr_data = stderr_reader.value.to_s

        # For Claude, output comes from stdout. For Codex, it's written via --output-last-message.
        yield(stdout_data) if block_given?

        if label == "Codex" && !wait_thread.value.success? && !File.exist?(output_path)
          error_output = stderr_data.empty? ? stdout_data : stderr_data
          File.write(output_path, "# REVIEW FAILED\n\nError: Codex exited with status #{wait_thread.value.exitstatus}\n\n#{error_output}")
        end

        elapsed = format_duration((Time.now - start).to_i)
        Progress.indent("#{label}: completed (#{elapsed})")
      rescue => e
        Progress.indent("#{label}: failed — #{e.message}")
        File.write(output_path, "# REVIEW FAILED\n\nError: #{e.message}") unless File.exist?(output_path)
      ensure
        [stdin, stdout, stderr].each { |io| io&.close rescue nil }
      end
    end

    def format_duration(seconds)
      seconds >= 60 ? "#{seconds / 60}m#{seconds % 60}s" : "#{seconds}s"
    end

    def format_bytes(bytes)
      if bytes < 1024
        "#{bytes}B"
      elsif bytes < 1_048_576
        "#{(bytes / 1024.0).round(1)}KB"
      else
        "#{(bytes / 1_048_576.0).round(1)}MB"
      end
    end
  end
end

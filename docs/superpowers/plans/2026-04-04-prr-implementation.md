# PRR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Ruby CLI tool (`prr`) that runs Claude and Codex as parallel PR reviewers with a Claude arbiter, producing a structured report and optional GitHub line comments.

**Architecture:** Shell-out orchestrator in Ruby. The script builds prompts, spawns `claude -p` and `codex exec` as subprocesses with timeouts, collects results, then runs arbiter rounds via `claude -p`. All state lives in `tmp/reviews/` as markdown files.

**Tech Stack:** Ruby 3.3 (stdlib only — no gems), Claude CLI, Codex CLI, GitHub CLI (`gh`), Jira REST API via `Net::HTTP`.

**Spec:** `docs/superpowers/specs/2026-04-04-prr-design.md`

---

## File Structure

```
bin/prr                            — Entry point, requires lib/prr/cli and calls Prr::Cli.run(ARGV)
lib/prr/cli.rb                     — Argument parsing (OptionParser), --help, routes to setup or review
lib/prr/config.rb                  — Loads config: defaults -> YAML file -> env vars -> CLI flags
lib/prr/setup.rb                   — Interactive config wizard, writes config/prr.yml
lib/prr/progress.rb                — Timestamped log output to $stdout
lib/prr/preflight.rb               — Disk check, PR resolution (gh), Jira ticket inference + fetch
lib/prr/sandbox.rb                 — cp -r repo, git fetch/checkout PR branch, cleanup
lib/prr/prompt_builder.rb          — Reads repo docs, diff, ticket; renders ERB prompt templates
lib/prr/agent_runner.rb            — Spawns claude/codex with timeout, captures output
lib/prr/arbiter.rb                 — Arbiter round loop: build questions, dispatch, log
lib/prr/report.rb                  — Parses final report, extracts line comments
lib/prr/github_commenter.rb        — Interactive comment selection, posts via gh api
lib/prr/review_runner.rb           — Main orchestrator that ties all phases together
config/prompts/review.md.erb       — Shared review prompt template for both agents
config/prompts/arbiter.md.erb      — Arbiter prompt (reads both reviews, produces questions or report)
config/prompts/arbiter_question.md.erb — Follow-up question prompt for individual agents
```

---

### Task 1: Project skeleton and entry point

**Files:**
- Create: `bin/prr`
- Create: `lib/prr/cli.rb`

- [ ] **Step 1: Create bin/prr**

```ruby
#!/usr/bin/env ruby
# frozen_string_literal: true

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))
require "prr/cli"

Prr::Cli.run(ARGV)
```

- [ ] **Step 2: Create lib/prr/cli.rb**

```ruby
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
          Prr::GithubCommenter.run_from_latest(@options)
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
        opts.on("--comments") { @options[:comments] = true }
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
          --comments                 Post line comments from the latest review to GitHub.
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
          prr https://github.com/org/repo/pull/123 --comments
      HELP
    end
  end
end
```

- [ ] **Step 3: Make executable and test**

```bash
chmod +x bin/prr
bin/prr --help
```

Expected: Help text prints correctly.

- [ ] **Step 4: Commit**

```bash
git add bin/prr lib/prr/cli.rb
git commit -m "feat: add prr entry point with CLI parsing and --help"
```

---

### Task 2: Progress logger

**Files:**
- Create: `lib/prr/progress.rb`

- [ ] **Step 1: Create lib/prr/progress.rb**

```ruby
# frozen_string_literal: true

module Prr
  module Progress
    module_function

    def log(message)
      $stdout.puts "[#{stamp}] #{message}"
      $stdout.flush
    end

    def indent(message)
      $stdout.puts "[#{stamp}]   #{message}"
      $stdout.flush
    end

    def done(message)
      $stdout.puts "[#{stamp}] ✓ #{message}"
      $stdout.flush
    end

    def error(message)
      $stderr.puts "[#{stamp}] ERROR: #{message}"
      $stderr.flush
    end

    def abort(message)
      error(message)
      exit 1
    end

    def stamp
      Time.now.strftime("%H:%M:%S")
    end
  end
end
```

- [ ] **Step 2: Commit**

```bash
git add lib/prr/progress.rb
git commit -m "feat: add timestamped progress logger"
```

---

### Task 3: Config loading

**Files:**
- Create: `lib/prr/config.rb`

- [ ] **Step 1: Create lib/prr/config.rb**

```ruby
# frozen_string_literal: true

require "yaml"

module Prr
  class Config
    DEFAULTS = {
      "base_repo_path" => "~/fuga/git",
      "tmp_path" => "tmp/reviews",
      "claude_timeout" => 600,
      "codex_timeout" => 900,
      "arbiter_rounds" => 3,
      "min_disk_space_gb" => 10,
      "github_user" => "",
      "jira_base_url" => "",
      "jira_api_token" => "",
      "jira_email" => ""
    }.freeze

    ENV_PREFIX = "PRR_"

    def self.config_path
      File.expand_path("../../config/prr.yml", __dir__)
    end

    def self.root_path
      File.expand_path("../..", __dir__)
    end

    def self.load(cli_overrides = {})
      new(cli_overrides)
    end

    attr_reader :data

    def initialize(cli_overrides = {})
      @data = DEFAULTS.dup
      merge_yaml!
      merge_env!
      merge_cli!(cli_overrides)
      expand_paths!
    end

    def [](key) = @data[key.to_s]
    def base_repo_path = @data["base_repo_path"]
    def tmp_path = @data["tmp_path"]
    def claude_timeout = @data["claude_timeout"].to_i
    def codex_timeout = @data["codex_timeout"].to_i
    def arbiter_rounds = @data["arbiter_rounds"].to_i
    def min_disk_space_gb = @data["min_disk_space_gb"].to_i
    def github_user = @data["github_user"]
    def jira_base_url = @data["jira_base_url"]
    def jira_api_token = @data["jira_api_token"]
    def jira_email = @data["jira_email"]

    private

    def merge_yaml!
      path = self.class.config_path
      return unless File.exist?(path)

      yaml = YAML.safe_load_file(path) || {}
      yaml.each { |k, v| @data[k.to_s] = v unless v.nil? }
    end

    def merge_env!
      DEFAULTS.each_key do |key|
        val = ENV["#{ENV_PREFIX}#{key.upcase}"]
        @data[key] = val if val && !val.empty?
      end
    end

    def merge_cli!(overrides)
      overrides.each { |k, v| @data[k.to_s] = v unless v.nil? }
    end

    def expand_paths!
      @data["base_repo_path"] = File.expand_path(@data["base_repo_path"])
      @data["tmp_path"] = File.expand_path(@data["tmp_path"], self.class.root_path)
    end
  end
end
```

- [ ] **Step 2: Verify**

```bash
ruby -e '$LOAD_PATH.unshift("lib"); require "prr/config"; c = Prr::Config.load; puts c.base_repo_path; puts c.claude_timeout'
```

Expected: Prints expanded `~/fuga/git` path and `600`.

- [ ] **Step 3: Commit**

```bash
git add lib/prr/config.rb
git commit -m "feat: add config loading — defaults, YAML, env vars, CLI overrides"
```

---

### Task 4: Interactive setup wizard

**Files:**
- Create: `lib/prr/setup.rb`

- [ ] **Step 1: Create lib/prr/setup.rb**

```ruby
# frozen_string_literal: true

require "yaml"
require "prr/config"
require "prr/progress"

module Prr
  class Setup
    SENSITIVE_KEYS = %w[jira_api_token].freeze

    FIELDS = [
      { key: "base_repo_path", label: "Base repo path", default: "~/fuga/git" },
      { key: "github_user", label: "GitHub username", default: "" },
      { key: "claude_timeout", label: "Claude timeout in seconds", default: 600 },
      { key: "codex_timeout", label: "Codex timeout in seconds", default: 900 },
      { key: "arbiter_rounds", label: "Arbiter rounds", default: 3 },
      { key: "min_disk_space_gb", label: "Min disk space in GB", default: 10 },
      { key: "jira_base_url", label: "Jira base URL", default: "" },
      { key: "jira_email", label: "Jira email", default: "" },
      { key: "jira_api_token", label: "Jira API token", default: "" }
    ].freeze

    def self.run
      new.run
    end

    def run
      puts "PRR Setup"
      puts "========="
      puts

      existing = load_existing
      result = {}

      FIELDS.each do |field|
        current = existing[field[:key]] || field[:default]
        display = mask?(field[:key], current) ? "****" : current

        print "#{field[:label]} [#{display}]: "
        input = $stdin.gets&.strip

        result[field[:key]] = if input.nil? || input.empty?
                                current
                              elsif field[:default].is_a?(Integer)
                                input.to_i
                              else
                                input
                              end
      end

      write_config(result)
      puts
      Progress.done("Config written to #{Config.config_path}")
      validate_tools
    end

    private

    def load_existing
      path = Config.config_path
      return {} unless File.exist?(path)
      YAML.safe_load_file(path) || {}
    end

    def write_config(config)
      dir = File.dirname(Config.config_path)
      Dir.mkdir(dir) unless Dir.exist?(dir)
      File.write(Config.config_path, YAML.dump(config))
    end

    def mask?(key, value)
      SENSITIVE_KEYS.include?(key) && value.is_a?(String) && !value.empty?
    end

    def validate_tools
      puts
      %w[claude codex gh].each do |tool|
        if system("which #{tool} > /dev/null 2>&1")
          Progress.log("#{tool}: found")
        else
          Progress.error("#{tool}: NOT FOUND — install before using prr")
        end
      end
    end
  end
end
```

- [ ] **Step 2: Test**

```bash
bin/prr setup
```

Expected: Prompts appear with defaults. Config file written on completion.

- [ ] **Step 3: Commit**

```bash
git add lib/prr/setup.rb
git commit -m "feat: add interactive setup wizard"
```

---

### Task 5: Preflight checks

**Files:**
- Create: `lib/prr/preflight.rb`

- [ ] **Step 1: Create lib/prr/preflight.rb**

```ruby
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
      # df -g output: Filesystem 1G-blocks Used Available Capacity ...
      # Last line has the data, 4th column is available
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
```

- [ ] **Step 2: Commit**

```bash
git add lib/prr/preflight.rb
git commit -m "feat: add preflight — disk check, PR resolution, Jira ticket"
```

---

### Task 6: Sandbox management

**Files:**
- Create: `lib/prr/sandbox.rb`

- [ ] **Step 1: Create lib/prr/sandbox.rb**

```ruby
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
      output, = Open3.capture2("git", "-C", @repo_path, "diff", "#{base_branch}..pr-review")
      output
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
  end
end
```

- [ ] **Step 2: Commit**

```bash
git add lib/prr/sandbox.rb
git commit -m "feat: add sandbox — repo copy, PR checkout, cleanup"
```

---

### Task 7: Prompt builder with ERB templates

**Files:**
- Create: `lib/prr/prompt_builder.rb`
- Create: `config/prompts/review.md.erb`
- Create: `config/prompts/arbiter.md.erb`
- Create: `config/prompts/arbiter_question.md.erb`

- [ ] **Step 1: Create lib/prr/prompt_builder.rb**

```ruby
# frozen_string_literal: true

require "erb"

module Prr
  class PromptBuilder
    PROMPTS_DIR = File.expand_path("../../config/prompts", __dir__)

    def initialize(sandbox:, preflight:)
      @sandbox = sandbox
      @preflight = preflight
    end

    def review_prompt
      render("review.md.erb", review_context)
    end

    def arbiter_prompt(claude_review:, codex_review:, round_history: "")
      render("arbiter.md.erb", {
        claude_review: claude_review,
        codex_review: codex_review,
        round_history: round_history,
        **review_context
      })
    end

    def arbiter_question_prompt(agent_name:, questions:, previous_review:)
      render("arbiter_question.md.erb", {
        agent_name: agent_name,
        questions: questions,
        previous_review: previous_review,
        **review_context
      })
    end

    private

    def review_context
      pr = @preflight.pr_data
      ticket = @preflight.ticket_data
      base_branch = pr["baseRefName"]

      repo_docs = ["CLAUDE.md", "AGENTS.md", "README.md"]
                    .filter_map { |f| content = @sandbox.read_repo_file(f); "### #{f}\n#{content}" if content }
                    .join("\n\n")

      changed_files = (pr["files"] || []).map { |f| f["path"] }.join("\n")

      prev_path = @sandbox.previous_review_path
      previous_review = prev_path ? File.read(prev_path) : nil

      {
        pr_number: pr["number"],
        pr_title: pr["title"],
        pr_url: pr["url"],
        pr_author: pr.dig("author", "login") || "unknown",
        pr_body: pr["body"] || "",
        head_branch: pr["headRefName"],
        base_branch: base_branch,
        repo: @preflight.repo,
        ticket_id: @preflight.ticket_id || "None",
        ticket_summary: ticket&.dig("fields", "summary"),
        ticket_description: ticket&.dig("fields", "description"),
        repo_docs: repo_docs.empty? ? nil : repo_docs,
        changed_files: changed_files,
        diff: @sandbox.diff(base_branch),
        previous_review: previous_review
      }
    end

    def render(template_name, vars)
      path = File.join(PROMPTS_DIR, template_name)
      template = File.read(path)
      b = binding
      vars.each { |k, v| b.local_variable_set(k, v) }
      ERB.new(template, trim_mode: "-").result(b)
    end
  end
end
```

- [ ] **Step 2: Create config/prompts/review.md.erb**

The template content uses ERB tags. Create the file with the review prompt structure covering: context (PR metadata, ticket, repo docs, previous review if any), diff, review instructions (9-point checklist), and output format. Variables available: `pr_number`, `pr_title`, `pr_url`, `pr_author`, `head_branch`, `base_branch`, `repo`, `ticket_id`, `ticket_summary`, `ticket_description`, `repo_docs`, `changed_files`, `diff`, `previous_review`.

The template should follow the spec's Prompt Structure section exactly. The output format section must match the spec's Final Report format (Verdict, Confidence, all sections through Open Questions).

- [ ] **Step 3: Create config/prompts/arbiter.md.erb**

Arbiter prompt template. Variables: `claude_review`, `codex_review`, `round_history`, plus all review context vars.

The arbiter's job:
1. Read both reviews and any round history.
2. Identify disagreements, unsubstantiated claims, gaps.
3. Output either: questions for each agent (as JSON: `{"claude": ["q1", "q2"], "codex": ["q1"]}`) OR the final report if no questions remain.
4. On the last round: output forced choices as JSON: `{"claude": [{"question": "...", "choices": ["A", "B", "C"]}], "codex": [...]}`.

- [ ] **Step 4: Create config/prompts/arbiter_question.md.erb**

Follow-up question prompt sent to individual agents. Variables: `agent_name`, `questions`, `previous_review`, plus all review context vars.

Tells the agent: here are questions from the arbiter. Answer each one. You can read/modify files in the sandbox to prove your answers.

- [ ] **Step 5: Commit**

```bash
git add lib/prr/prompt_builder.rb config/prompts/
git commit -m "feat: add prompt builder with ERB templates for review and arbiter"
```

---

### Task 8: Agent runner (parallel Claude + Codex with timeouts)

**Files:**
- Create: `lib/prr/agent_runner.rb`

- [ ] **Step 1: Create lib/prr/agent_runner.rb**

```ruby
# frozen_string_literal: true

require "open3"
require "timeout"
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

      Progress.log("Starting parallel review...")

      threads = []

      threads << Thread.new do
        run_claude(claude_prompt_path, claude_result_path, @config.claude_timeout)
      end

      threads << Thread.new do
        run_codex(codex_prompt_path, codex_result_path, @config.codex_timeout)
      end

      Progress.indent("Claude: running (timeout: #{format_duration(@config.claude_timeout)})")
      Progress.indent("Codex:  running (timeout: #{format_duration(@config.codex_timeout)})")

      threads.each(&:join)

      {
        claude: File.exist?(claude_result_path) ? File.read(claude_result_path) : "",
        codex: File.exist?(codex_result_path) ? File.read(codex_result_path) : ""
      }
    end

    def run_agent(agent, prompt_text, output_path, timeout)
      case agent
      when :claude then run_claude_inline(prompt_text, output_path, timeout)
      when :codex then run_codex_inline(prompt_text, output_path, timeout)
      end
    end

    private

    def run_claude(prompt_path, output_path, timeout_secs)
      start = Time.now
      cmd = [
        "claude", "-p",
        "--dangerously-skip-permissions",
        "--output-format", "text"
      ]

      run_with_timeout(cmd, prompt_path, output_path, timeout_secs, "Claude", start)
    end

    def run_codex(prompt_path, output_path, timeout_secs)
      start = Time.now
      cmd = [
        "codex", "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "-o", output_path
      ]

      run_with_timeout(cmd, prompt_path, output_path, timeout_secs, "Codex", start)
    end

    def run_claude_inline(prompt_text, output_path, timeout_secs)
      start = Time.now
      prompt_path = "#{output_path}.prompt.md"
      File.write(prompt_path, prompt_text)
      run_claude(prompt_path, output_path, timeout_secs)
    end

    def run_codex_inline(prompt_text, output_path, timeout_secs)
      start = Time.now
      prompt_path = "#{output_path}.prompt.md"
      File.write(prompt_path, prompt_text)
      run_codex(prompt_path, output_path, timeout_secs)
    end

    def run_with_timeout(cmd, prompt_path, output_path, timeout_secs, label, start)
      prompt_content = File.read(prompt_path)

      pid = nil
      begin
        stdin, stdout, stderr, wait_thread = Open3.popen3(*cmd, chdir: @sandbox.repo_path)
        pid = wait_thread.pid
        stdin.write(prompt_content)
        stdin.close

        unless wait_thread.join(timeout_secs)
          Process.kill("TERM", pid)
          wait_thread.join(5) || Process.kill("KILL", pid)
          elapsed = format_duration((Time.now - start).to_i)
          Progress.indent("#{label}: TIMEOUT after #{elapsed}")

          partial = begin; stdout.read; rescue; ""; end
          File.write(output_path, "# PARTIAL REVIEW (timeout after #{elapsed})\n\n#{partial}")
          return
        end

        output = stdout.read
        err = stderr.read

        # For codex exec -o, output is written to file directly.
        # For claude -p, output comes from stdout.
        if label == "Claude"
          File.write(output_path, output)
        end
        # Codex writes to output_path via -o flag

        elapsed = format_duration((Time.now - start).to_i)
        Progress.indent("#{label}: completed (#{elapsed})")
      rescue => e
        Progress.indent("#{label}: failed — #{e.message}")
        File.write(output_path, "# REVIEW FAILED\n\nError: #{e.message}")
      ensure
        [stdin, stdout, stderr].each { |io| io&.close rescue nil }
      end
    end

    def format_duration(seconds)
      if seconds >= 60
        "#{seconds / 60}m#{seconds % 60}s"
      else
        "#{seconds}s"
      end
    end
  end
end
```

- [ ] **Step 2: Commit**

```bash
git add lib/prr/agent_runner.rb
git commit -m "feat: add agent runner — parallel Claude/Codex with timeouts"
```

---

### Task 9: Arbiter round logic

**Files:**
- Create: `lib/prr/arbiter.rb`

- [ ] **Step 1: Create lib/prr/arbiter.rb**

```ruby
# frozen_string_literal: true

require "json"
require "prr/progress"

module Prr
  class Arbiter
    def initialize(config:, agent_runner:, prompt_builder:, results_path:)
      @config = config
      @runner = agent_runner
      @builder = prompt_builder
      @results_path = results_path
      @log_lines = []
    end

    def run!(claude_review:, codex_review:)
      max_rounds = @config.arbiter_rounds
      round_history = ""

      Progress.log("Starting arbiter (max #{max_rounds} rounds)...")

      (1..max_rounds).each do |round|
        is_last = (round == max_rounds)
        Progress.log("Arbiter round #{round}/#{max_rounds}#{is_last ? " (forced choice)" : ""}...")

        arbiter_prompt = @builder.arbiter_prompt(
          claude_review: claude_review,
          codex_review: codex_review,
          round_history: round_history
        )

        # Add instruction for last round
        if is_last
          arbiter_prompt += "\n\nThis is the FINAL round. For any remaining disagreements, present forced choices. Output your final-report.md directly."
        end

        response = run_arbiter(arbiter_prompt)

        # Try to parse as questions JSON
        questions = parse_questions(response)

        if questions.nil? || (questions["claude"].empty? && questions["codex"].empty?)
          # No questions — arbiter is producing final report
          @log_lines << "## Round #{round}\nNo questions. Proceeding to final report.\n"
          write_log!
          return response
        end

        @log_lines << "## Round #{round}\n"

        # Dispatch questions to agents in parallel
        threads = []
        round_responses = {}

        if questions["claude"] && !questions["claude"].empty?
          q_text = format_questions(questions["claude"])
          Progress.indent("Asking Claude #{questions["claude"].length} question(s)...")
          @log_lines << "### Questions for Claude\n#{q_text}\n"

          threads << Thread.new do
            prompt = @builder.arbiter_question_prompt(
              agent_name: "Claude",
              questions: q_text,
              previous_review: claude_review
            )
            path = File.join(@results_path, "round-#{round}-claude.md")
            @runner.run_agent(:claude, prompt, path, @config.claude_timeout)
            round_responses[:claude] = File.exist?(path) ? File.read(path) : ""
          end
        else
          Progress.indent("No questions for Claude this round.")
          @log_lines << "### Questions for Claude\n(none)\n"
        end

        if questions["codex"] && !questions["codex"].empty?
          q_text = format_questions(questions["codex"])
          Progress.indent("Asking Codex #{questions["codex"].length} question(s)...")
          @log_lines << "### Questions for Codex\n#{q_text}\n"

          threads << Thread.new do
            prompt = @builder.arbiter_question_prompt(
              agent_name: "Codex",
              questions: q_text,
              previous_review: codex_review
            )
            path = File.join(@results_path, "round-#{round}-codex.md")
            @runner.run_agent(:codex, prompt, path, @config.codex_timeout)
            round_responses[:codex] = File.exist?(path) ? File.read(path) : ""
          end
        else
          Progress.indent("No questions for Codex this round.")
          @log_lines << "### Questions for Codex\n(none)\n"
        end

        threads.each(&:join)
        Progress.indent("Responses received.")

        # Log responses
        if round_responses[:claude]
          @log_lines << "### Claude Response\n#{round_responses[:claude]}\n"
        end
        if round_responses[:codex]
          @log_lines << "### Codex Response\n#{round_responses[:codex]}\n"
        end

        # Build round history for next iteration
        round_history += "\n## Round #{round} Q&A\n"
        round_history += "Claude response: #{round_responses[:claude]}\n" if round_responses[:claude]
        round_history += "Codex response: #{round_responses[:codex]}\n" if round_responses[:codex]
      end

      # After all rounds, generate final report
      Progress.log("Generating final report...")
      final_prompt = @builder.arbiter_prompt(
        claude_review: claude_review,
        codex_review: codex_review,
        round_history: round_history
      )
      final_prompt += "\n\nAll Q&A rounds are complete. Produce the final-report.md now."

      write_log!
      run_arbiter(final_prompt)
    end

    private

    def run_arbiter(prompt)
      path = File.join(@results_path, "arbiter-tmp-#{Time.now.to_i}.md")
      @runner.run_agent(:claude, prompt, path, @config.claude_timeout)
      File.exist?(path) ? File.read(path) : ""
    end

    def parse_questions(response)
      # Look for JSON block in response
      json_match = response.match(/```json\s*\n(.*?)\n\s*```/m)
      if json_match
        JSON.parse(json_match[1])
      else
        # Try parsing the whole response as JSON
        JSON.parse(response)
      end
    rescue JSON::ParserError
      nil # Not questions — likely the final report
    end

    def format_questions(questions)
      if questions.is_a?(Array)
        questions.each_with_index.map { |q, i| "#{i + 1}. #{q}" }.join("\n")
      else
        questions.to_s
      end
    end

    def write_log!
      path = File.join(@results_path, "arbiter-log.md")
      File.write(path, "# Arbiter Log\n\n#{@log_lines.join("\n")}")
    end
  end
end
```

- [ ] **Step 2: Commit**

```bash
git add lib/prr/arbiter.rb
git commit -m "feat: add arbiter — multi-round Q&A with forced choice final round"
```

---

### Task 10: Report parser and line comment extraction

**Files:**
- Create: `lib/prr/report.rb`

- [ ] **Step 1: Create lib/prr/report.rb**

```ruby
# frozen_string_literal: true

module Prr
  class Report
    LINE_COMMENT_PATTERN = /^-\s*`([^`]+?):(\d+)`\s*[—–-]\s*(.+)$/

    attr_reader :content, :verdict, :confidence, :line_comments

    def initialize(content)
      @content = content
      parse!
    end

    def save!(results_path)
      path = File.join(results_path, "final-report.md")
      File.write(path, @content)
      path
    end

    private

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
```

- [ ] **Step 2: Commit**

```bash
git add lib/prr/report.rb
git commit -m "feat: add report parser with line comment extraction"
```

---

### Task 11: GitHub comment poster

**Files:**
- Create: `lib/prr/github_commenter.rb`

- [ ] **Step 1: Create lib/prr/github_commenter.rb**

```ruby
# frozen_string_literal: true

require "json"
require "open3"
require "prr/config"
require "prr/progress"
require "prr/report"

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

    def post_review!(comments)
      Progress.log("Posting review to GitHub...")

      # Fetch the PR's head SHA for the review
      cmd = "gh pr view #{@pr_number} --repo #{@owner}/#{@repo} --json headRefOid --jq .headRefOid"
      sha, status = Open3.capture2(cmd)
      Progress.abort("Failed to get PR head SHA") unless status.success?
      sha = sha.strip

      # Fetch diff to map file paths to diff positions
      diff_cmd = "gh api repos/#{@owner}/#{@repo}/pulls/#{@pr_number} --jq .diff_url"
      diff_url, = Open3.capture2(diff_cmd)

      review_event = REVIEW_STATUS_MAP[@report.verdict] || "COMMENT"

      body = {
        commit_id: sha,
        event: review_event,
        body: "PRR Review — Verdict: #{@report.verdict} (#{@report.confidence} confidence)",
        comments: comments.map do |c|
          {
            path: c[:path],
            line: c[:line],
            body: c[:body]
          }
        end
      }

      json_path = File.join(@config.tmp_path, "review-payload.json")
      File.write(json_path, JSON.pretty_generate(body))

      post_cmd = "gh api repos/#{@owner}/#{@repo}/pulls/#{@pr_number}/reviews --input #{json_path}"
      output, status = Open3.capture2(post_cmd)

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
```

- [ ] **Step 2: Commit**

```bash
git add lib/prr/github_commenter.rb
git commit -m "feat: add GitHub commenter — interactive line comment posting"
```

---

### Task 12: Main orchestrator (review_runner.rb)

**Files:**
- Create: `lib/prr/review_runner.rb`

- [ ] **Step 1: Create lib/prr/review_runner.rb**

```ruby
# frozen_string_literal: true

require "prr/config"
require "prr/progress"
require "prr/preflight"
require "prr/sandbox"
require "prr/prompt_builder"
require "prr/agent_runner"
require "prr/arbiter"
require "prr/report"
require "prr/github_commenter"

module Prr
  class ReviewRunner
    def initialize(options)
      @options = options
      @config = Config.load(options)
    end

    def run
      preflight = Preflight.new(@config, @options).run!

      sandbox = Sandbox.new(@config, preflight.owner, preflight.repo, preflight.pr_number)

      # Check for previous review
      check_previous_review(sandbox)

      sandbox.setup!

      prompt_builder = PromptBuilder.new(sandbox: sandbox, preflight: preflight)
      agent_runner = AgentRunner.new(config: @config, sandbox: sandbox, results_path: sandbox.results_path)

      if @options[:arbiter_only]
        reviews = load_existing_reviews(sandbox.results_path)
      else
        prompt = prompt_builder.review_prompt
        reviews = agent_runner.run_parallel_review!(prompt)
      end

      # Run arbiter
      arbiter = Arbiter.new(
        config: @config,
        agent_runner: agent_runner,
        prompt_builder: prompt_builder,
        results_path: sandbox.results_path
      )
      final_content = arbiter.run!(claude_review: reviews[:claude], codex_review: reviews[:codex])

      # Save and display report
      report = Report.new(final_content)
      report_path = report.save!(sandbox.results_path)

      sandbox.cleanup!

      # Print summary
      puts
      Progress.done("Done.")
      puts
      puts "Report: #{report_path}"
      puts "Verdict: #{report.verdict} (#{report.confidence} Confidence)"
      puts "#{report.line_comments.length} line comment(s) ready."
      puts

      # Offer to post comments
      commenter = GithubCommenter.new(
        @config, preflight.owner, preflight.repo, preflight.pr_number, report
      )
      commenter.run!
    end

    private

    def check_previous_review(sandbox)
      prev = sandbox.previous_review_path
      return unless prev

      timestamp = File.basename(File.dirname(prev))
      print "Previous review found from #{timestamp}. Use as context? (Y/n): "
      input = $stdin.gets&.strip&.downcase
      # Default to yes
      @options[:use_previous] = (input != "n")
    end

    def load_existing_reviews(results_path)
      claude_path = File.join(results_path, "claude-review.md")
      codex_path = File.join(results_path, "codex-review.md")

      {
        claude: File.exist?(claude_path) ? File.read(claude_path) : "",
        codex: File.exist?(codex_path) ? File.read(codex_path) : ""
      }
    end
  end
end
```

- [ ] **Step 2: Commit**

```bash
git add lib/prr/review_runner.rb
git commit -m "feat: add review runner — main orchestrator tying all phases together"
```

---

### Task 13: ERB prompt templates

**Files:**
- Create: `config/prompts/review.md.erb`
- Create: `config/prompts/arbiter.md.erb`
- Create: `config/prompts/arbiter_question.md.erb`

- [ ] **Step 1: Create all three ERB template files**

Create `config/prompts/review.md.erb` with the full review prompt. It receives these local variables: `pr_number`, `pr_title`, `pr_url`, `pr_author`, `head_branch`, `base_branch`, `repo`, `ticket_id`, `ticket_summary`, `ticket_description`, `repo_docs`, `changed_files`, `diff`, `previous_review`.

Sections:
1. **Context** — PR metadata, ticket info, repo docs
2. **Previous Review** — only if `previous_review` is non-nil (re-review scenario)
3. **Changed Files** — list
4. **Diff** — full diff in a code block
5. **Instructions** — the 9-point review checklist from the spec
6. **Output Format** — the structured markdown format from the spec

Create `config/prompts/arbiter.md.erb` receiving: `claude_review`, `codex_review`, `round_history`, plus all review context vars.

Arbiter instructions:
- You are an arbiter judging two independent code reviews
- Compare findings, identify disagreements, gaps, unsubstantiated claims
- If you have questions, output JSON: `{"claude": ["q1"], "codex": ["q1"]}`
- If no questions, produce the final report directly
- Include an "Agent Agreement" section noting where reviewers agreed/disagreed

Create `config/prompts/arbiter_question.md.erb` receiving: `agent_name`, `questions`, `previous_review`, plus all review context vars.

Instructions:
- The arbiter has questions about your review
- Answer each question thoroughly
- You can read/modify files in the sandbox to prove your answers
- Be specific — cite file paths and line numbers

- [ ] **Step 2: Commit**

```bash
git add config/prompts/
git commit -m "feat: add ERB prompt templates for review, arbiter, and follow-up"
```

---

### Task 14: End-to-end smoke test

- [ ] **Step 1: Run prr --help to verify CLI works**

```bash
bin/prr --help
```

Expected: Full help text prints.

- [ ] **Step 2: Run prr setup to generate config**

```bash
bin/prr setup
```

Expected: Interactive prompts, config file generated at `config/prr.yml`.

- [ ] **Step 3: Run prr against a real PR**

Pick a small PR from one of the local repos and run:

```bash
bin/prr https://github.com/fuga/<repo>/pull/<number>
```

Expected: Full pipeline runs — preflight, sandbox, parallel review, arbiter, final report, comment prompt.

- [ ] **Step 4: Fix any issues found during smoke test**

Address any errors, adjust CLI flags for claude/codex if needed.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found during smoke test"
```

---

### Task 15: Final cleanup

- [ ] **Step 1: Ensure .gitignore is correct**

Verify `tmp/` and `config/prr.yml` are in `.gitignore`.

- [ ] **Step 2: Final commit**

```bash
git add .gitignore
git commit -m "chore: ensure gitignore covers tmp and config"
```

---

### Task 16: Codex agent review pass

**Files:**
- May modify: `lib/prr/agent_runner.rb` (Codex invocation flags)
- May modify: `config/prompts/review.md.erb` (prompt optimization for Codex)
- May modify: `config/prompts/arbiter_question.md.erb` (follow-up prompt for Codex)
- Must NOT modify: `lib/prr/arbiter.rb`, `lib/prr/report.rb`, `config/prompts/arbiter.md.erb`

- [ ] **Step 1: Review Codex CLI flags in agent_runner.rb**

Verify the `codex exec` invocation uses optimal flags:
- `-a never` (no approval loop)
- `-s workspace-write` for review, `-s read-only` for arbiter Q&A
- `--ephemeral` (skip session persistence)
- `--output-last-message <path>` (clean output capture)
- `-C <repo_path>` (working directory)

- [ ] **Step 2: Review prompt compatibility with Codex**

The review prompt in `config/prompts/review.md.erb` was written for both agents but may need Codex-specific optimization:
- "Budget your exploration" section — Codex benefits from explicit shell command budgets
- "Inference allowed" pattern — prevents Codex from endless codebase exploration
- Output format — must remain identical to what arbiter expects

- [ ] **Step 3: Verify output format contract**

The arbiter (`lib/prr/arbiter.rb`) expects:
- Review output matching the structured markdown in the Output Format section
- `## Verdict:`, `## Confidence:`, `## Line Comments` sections parseable by `lib/prr/report.rb`
- Line comments in format: `- \`path/to/file:LINE\` — description`

Any prompt changes must preserve this contract.

- [ ] **Step 4: Commit any Codex-specific improvements**

```bash
git add lib/prr/agent_runner.rb config/prompts/
git commit -m "refine: optimize Codex agent invocation and prompt patterns"
```

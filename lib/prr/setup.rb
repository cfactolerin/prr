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

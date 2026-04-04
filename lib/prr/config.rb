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

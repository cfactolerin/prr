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

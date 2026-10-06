# The metrics agent (config.alloy beside this file), as Render builds it for
# the clausecheck-metrics-<environment> private service. Pinned, like every
# image this project runs.
FROM grafana/alloy:v1.11.0
COPY config.alloy /etc/alloy/config.alloy
CMD ["run", "/etc/alloy/config.alloy", "--storage.path=/var/lib/alloy/data", "--server.http.listen-addr=0.0.0.0:12345"]

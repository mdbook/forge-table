# Forge Table multi-game server (router mode) from a release zip. Build the zip, then the image:
#   forge-gui-bridge/package.sh
#   docker build -t forge-table -f forge-gui-bridge/docker/Dockerfile --build-arg ZIP=target/dist/forge-table-<sha8>.zip forge-gui-bridge
# Run it behind an authenticating reverse proxy (compose.yaml), or for yourself alone on the host's loopback:
#   docker run --network host -e FT_BIND=127.0.0.1 -v forge-table:/data forge-table
# and open the link it prints. Settings are FT_<FLAG> variables (docs/forge-table/RUNBOOK.md); flags after the image
# name go to the server too.
FROM busybox:stable AS unpack
ARG ZIP
COPY ${ZIP} /ft.zip
RUN unzip -q /ft.zip -d /unpacked && mv /unpacked/forge-table-* /forge-table \
 # a server gives every game its own Forge home under /data: no shared user/ folder
 && rm /forge-table/forge.profile.properties /forge-table/launch.sh /forge-table/launch.cmd

FROM eclipse-temurin:21-jre
RUN useradd --system --home-dir /data --shell /usr/sbin/nologin forge-table \
 && mkdir /data && chown forge-table:forge-table /data
COPY --from=unpack /forge-table /opt/forge-table
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/forge-table
USER forge-table
WORKDIR /opt/forge-table
VOLUME /data
ENV FT_PORT=8790 FT_ADMIN_PORT=8799 FT_MTGAI_UPLOAD=off
EXPOSE 8790
# /healthz answers on the admin port, loopback only; a 200 alone could be anything, so it must say "ok":true
HEALTHCHECK --start-period=60s CMD curl -fsS http://127.0.0.1:8799/healthz | grep -q '"ok":true' || exit 1
ENTRYPOINT ["/usr/local/bin/forge-table"]

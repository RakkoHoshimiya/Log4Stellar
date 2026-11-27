ARG WEB_BASE=docker.io/library/debian:trixie-slim
ARG POSTGRES_IMAGE=docker.io/library/postgres:18@sha256:eb63372c1e05c755f55fa30cbd07aecc443676fc6c0fa90b9002d01537841e1a
ARG RUSTFS_IMAGE=docker.io/rustfs/rustfs@sha256:0dff1515b3c52b5ce8c5df2263420c7f93ae1c5d07cca79e19e57cff86b84c85
FROM $POSTGRES_IMAGE AS postgres-toolchain
RUN mkdir /client-library && find /usr/lib -name libpq.so.5 -exec cp -L '{}' /client-library/libpq.so.5 ';'
FROM $RUSTFS_IMAGE AS object-storage

FROM $WEB_BASE AS web
ARG DEBIAN_MIRROR=http://deb.debian.org
RUN sed -i "s|http://deb.debian.org|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl openssl tini gosu util-linux \
         python3 libseccomp2 git openssh-client \
         libreoffice-writer libreoffice-calc libreoffice-impress fonts-noto-cjk \
         poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 18023 stellar \
    && useradd --system --uid 18023 --gid stellar --home-dir /data/web --shell /usr/sbin/nologin stellar \
    && mkdir /data
COPY node /usr/local/bin/node
COPY release /opt/log4stellar/release
COPY container /opt/log4stellar/container
ENV LOG4STELLAR_DEPLOYMENT_MODE=external LOG4STELLAR_INTERNAL_PORT=8443 LOG4STELLAR_CONTAINER_CONVERSION=1
EXPOSE 8443
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=20s --timeout=5s --start-period=60s CMD ["/opt/log4stellar/container/health.sh"]
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/log4stellar/container/start.sh"]

FROM web AS standalone
RUN apt-get update \
    && apt-get install --no-install-recommends -y libxml2 libpam0g libssl3t64 libgssapi-krb5-2 libnuma1 \
         libldap2 libicu76 liburing2 libsystemd0 liblz4-1 libzstd1 tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 18022 rustfs \
    && useradd --system --uid 18022 --gid rustfs --home-dir /data/rustfs --shell /usr/sbin/nologin rustfs \
    && groupadd -g 18021 postgres \
    && useradd --system --uid 18021 --gid postgres --home-dir /data/postgres --shell /usr/sbin/nologin postgres
COPY --from=postgres-toolchain /usr/lib/postgresql/18 /usr/lib/postgresql/18
COPY --from=postgres-toolchain /usr/share/postgresql /usr/share/postgresql
COPY --from=postgres-toolchain /client-library/libpq.so.5 /usr/local/lib/libpq.so.5
COPY --from=object-storage /usr/bin/rustfs /usr/bin/rustfs
RUN ldconfig \
    && /usr/lib/postgresql/18/bin/postgres --version \
    && /usr/lib/postgresql/18/bin/pg_dump --version \
    && rustfs --version
ENV LOG4STELLAR_DEPLOYMENT_MODE=standalone PG_MAJOR=18 \
    PATH=/usr/lib/postgresql/18/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

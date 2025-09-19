FROM node:22-slim

# Install required dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    unzip \
    bash \
    libc6 \
    libicu72 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install .NET Runtime (SQLPackage dependency)
RUN wget https://dot.net/v1/dotnet-install.sh -O dotnet-install.sh \
    && chmod +x dotnet-install.sh \
    && ./dotnet-install.sh --runtime dotnet --channel 6.0 --install-dir /usr/share/dotnet \
    && ln -s /usr/share/dotnet/dotnet /usr/bin/dotnet \
    && rm dotnet-install.sh

# Set up environment variables
ENV PATH="/usr/share/dotnet:${PATH}"

# Download and install SQLPackage
RUN mkdir -p /opt/sqlpackage \
    && wget https://aka.ms/sqlpackage-linux -O sqlpackage.zip \
    && unzip sqlpackage.zip -d /opt/sqlpackage \
    && chmod +x /opt/sqlpackage/sqlpackage \
    && ln -s /opt/sqlpackage/sqlpackage /usr/local/bin/sqlpackage \
    && rm sqlpackage.zip

# Verify installation
RUN sqlpackage /version

WORKDIR /usr/app

COPY ["package*.json", "src/", "./"]

RUN npm install --omit=dev

CMD ["node", "src/ecs-deployer.js"]

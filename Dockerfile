FROM amazon/aws-lambda-python:3.12.2025.09.30.13-x86_64
RUN curl -sSL https://install.python-poetry.org | python3 -
ENV PATH="/root/.local/bin:$PATH"
WORKDIR /var/task
COPY pyproject.toml poetry.lock* ./
RUN poetry install --only main --no-root --no-interaction --no-ansi
COPY src/ ./
CMD ["app.handler"]

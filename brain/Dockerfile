FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# update and upgrade
RUN apt update
RUN apt upgrade -y

# install dependencies
RUN apt install -y python3 python3-pip curl

# install pipenv
RUN pip install pipenv
ENV PIPENV_VENV_IN_PROJECT=1

# create app directory
RUN mkdir -p /app
WORKDIR /app

# install python dependencies
ADD Pipfile .
RUN pipenv install

# copy app
COPY . .

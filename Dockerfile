#####################################################################
#
# A Docker image to convert audio and video for web using web API
#
#   with
#     - FFMPEG (built)
#     - NodeJS
#     - fluent-ffmpeg
#
#   For more on Fluent-FFMPEG, see 
#
#            https://github.com/fluent-ffmpeg/node-fluent-ffmpeg
#
# Original image and FFMPEG API by Paul Visco
# https://github.com/surebert/docker-ffmpeg-service
#
#####################################################################

FROM node:18.14-alpine3.16 as build

RUN apk add --no-cache git

# install pkg
RUN npm install -g pkg

ENV PKG_CACHE_PATH /usr/cache

WORKDIR /usr/src/app

# Bundle app source
COPY ./src .
RUN npm install

# Create single binary file
RUN pkg --targets node18-alpine-x64 /usr/src/app/package.json


FROM jrottenberg/ffmpeg:4.4-alpine

# Install base fonts and fontconfig
RUN apk add --no-cache ttf-freefont fontconfig

# Copy custom fonts (Bebas Neue, Open Sans)
COPY fonts/*.ttf /usr/share/fonts/custom/

# Replace fonts.conf with a simplified version compatible with the older
# fontconfig library bundled in the jrottenberg/ffmpeg image.
# The Alpine 3.13 generated fonts.conf uses its:rules (ITS schema) which
# that older library cannot parse, causing "Cannot load default config file".
COPY fonts/fonts.conf /etc/fonts/fonts.conf

# Point fontconfig to our simplified config at runtime
ENV FONTCONFIG_FILE=/etc/fonts/fonts.conf

# Pre-build font cache into /var/cache/fontconfig
RUN mkdir -p /var/cache/fontconfig && fc-cache -f /usr/share/fonts/ 2>/dev/null || true

# Create user and change workdir
RUN adduser --disabled-password --home /home/ffmpgapi ffmpgapi
WORKDIR /home/ffmpgapi

# Copy files from build stage
COPY --from=build /usr/src/app/ffmpegapi .
COPY --from=build /usr/src/app/index.html .
RUN chown ffmpgapi:ffmpgapi * && chmod 755 ffmpegapi

# "uploads" is the base directory for the POST /convert/video "localFile" input
# source. It's meant to be mounted as a volume (see docker-compose.yml) so files
# can be shared with other containers (e.g. n8n) without an HTTP upload.
RUN mkdir -p /home/ffmpgapi/uploads && chown ffmpgapi:ffmpgapi /home/ffmpgapi/uploads

EXPOSE 3000

# Change user
USER ffmpgapi

ENTRYPOINT []
CMD [ "./ffmpegapi" ]


# 构建阶段
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /build

# 先只拷 pom，让依赖层可以被缓存复用
COPY pom.xml .
RUN mvn -B -q dependency:go-offline

COPY src ./src
RUN mvn -B -q clean package -DskipTests

# 运行阶段
FROM eclipse-temurin:17-jre-jammy
WORKDIR /app

# 时区和中文渲染：生成缩略图要用到字体相关的 AWT，缺字体时中文会变方块
ENV TZ=Asia/Shanghai \
    JAVA_OPTS="-XX:MaxRAMPercentage=75 -Djava.awt.headless=true -Dfile.encoding=UTF-8" \
    PICMAN_DB_PATH=/data/picman.db \
    PICMAN_CACHE_DIR=/data/cache

RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /build/target/picman-*.jar /app/picman.jar

# 数据目录必须挂卷，否则容器重建会丢索引和缓存
RUN mkdir -p /data/cache/thumbs
VOLUME ["/data"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD curl -fsS http://localhost:8080/actuator/health || exit 1

ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS -jar /app/picman.jar"]

package com.zcode.picman.baidu;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "baidu")
public record BaiduPanProperties(
        String appKey,
        String secretKey,
        String appId,
        String signKey,
        String uploadHost,
        long sliceSize,
        int connectTimeoutMs,
        int readTimeoutMs
) {

    public BaiduPanProperties {
        if (uploadHost == null || uploadHost.isBlank()) uploadHost = "https://d.pcs.baidu.com";
        if (sliceSize <= 0) sliceSize = 4L * 1024 * 1024;
        if (connectTimeoutMs <= 0) connectTimeoutMs = 10_000;
        if (readTimeoutMs <= 0) readTimeoutMs = 120_000;
    }

    public boolean isConfigured() {
        return appKey != null && !appKey.isBlank() && secretKey != null && !secretKey.isBlank();
    }
}

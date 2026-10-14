package com.zcode.picman.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.Arrays;
import java.util.List;

@ConfigurationProperties(prefix = "picman")
public record AppProperties(
        String jwtSecret,
        int sessionHours,
        String baseDir,
        String dbPath,
        String cacheDir,
        int thumbSize,
        String dlinkHostAllowlist,
        boolean cookieSecure
) {

    public AppProperties {
        if (sessionHours <= 0) sessionHours = 168;
        if (thumbSize <= 0) thumbSize = 400;
        if (baseDir == null || baseDir.isBlank()) baseDir = "/apps/picman";
        // 统一去掉结尾斜杠，后续拼接只补一次
        while (baseDir.length() > 1 && baseDir.endsWith("/")) {
            baseDir = baseDir.substring(0, baseDir.length() - 1);
        }
    }

    public List<String> allowedDlinkHostSuffixes() {
        String raw = dlinkHostAllowlist == null ? "" : dlinkHostAllowlist;
        return Arrays.stream(raw.split(","))
                .map(String::trim)
                .map(String::toLowerCase)
                .filter(s -> !s.isEmpty())
                .toList();
    }
}

package com.zcode.picman.security;

import com.zcode.picman.config.AppProperties;
import com.zcode.picman.repository.SystemConfigRepository;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.Date;

/**
 * 管理员会话令牌。
 * <p>
 * 签名密钥优先取 PICMAN_JWT_SECRET；没配就在首次启动时随机生成并写进数据库，
 * 这样重启后已登录用户不会被登出，同时也不会在代码或 Git 里留下固定密钥。
 */
@Service
public class JwtService {

    private static final Logger log = LoggerFactory.getLogger(JwtService.class);
    private static final String CONFIG_KEY = "picman.jwt_secret";

    private final SecretKey key;
    private final long sessionMillis;
    private final String issuer = "picman";

    public JwtService(AppProperties props, SystemConfigRepository config) {
        String secret = props.jwtSecret();
        if (secret == null || secret.isBlank()) {
            secret = config.find(CONFIG_KEY).orElseGet(() -> {
                byte[] random = new byte[32];
                new SecureRandom().nextBytes(random);
                String generated = Base64.getEncoder().encodeToString(random);
                config.put(CONFIG_KEY, generated);
                log.info("已生成新的会话签名密钥并保存到数据库");
                return generated;
            });
        }
        this.key = Keys.hmacShaKeyFor(sha256(secret));
        this.sessionMillis = props.sessionHours() * 3600_000L;
    }

    public String issue(String username) {
        Instant now = Instant.now();
        return Jwts.builder()
                .issuer(issuer)
                .subject(username)
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plusMillis(sessionMillis)))
                .signWith(key)
                .compact();
    }

    /** 解析并校验令牌，无效返回 null（不抛异常，避免过滤器里到处 try/catch） */
    public String parse(String token) {
        if (token == null || token.isBlank()) {
            return null;
        }
        try {
            Claims claims = Jwts.parser()
                    .verifyWith(key)
                    .requireIssuer(issuer)
                    .build()
                    .parseSignedClaims(token)
                    .getPayload();
            return claims.getSubject();
        } catch (JwtException | IllegalArgumentException e) {
            return null;
        }
    }

    public long sessionSeconds() {
        return sessionMillis / 1000;
    }

    private static byte[] sha256(String s) {
        try {
            // 用 SHA-256 派生定长密钥，这样用户配多短的字符串都不会因长度不够而报错
            return MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("JVM 不支持 SHA-256", e);
        }
    }
}

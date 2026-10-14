package com.zcode.picman.baidu;

import com.zcode.picman.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.util.List;

/**
 * dlink / 缩略图地址的主机校验，防 SSRF。
 * <p>
 * 百度返回的下载地址会跳到 CDN，主机名不完全固定，所以用后缀白名单而不是硬编码单台主机。
 * 重定向链上的每一跳都要过这里，不能只校验第一跳。
 */
@Component
public class DlinkGuard {

    private static final Logger log = LoggerFactory.getLogger(DlinkGuard.class);

    private final List<String> allowedSuffixes;

    public DlinkGuard(AppProperties props) {
        this.allowedSuffixes = props.allowedDlinkHostSuffixes();
        log.info("dlink 主机白名单：{}", allowedSuffixes);
    }

    public boolean isAllowed(String url) {
        if (url == null || url.isBlank()) {
            return false;
        }
        URI uri;
        try {
            uri = URI.create(url.trim());
        } catch (IllegalArgumentException e) {
            return false;
        }
        String scheme = uri.getScheme();
        if (scheme == null || !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https"))) {
            return false;
        }
        String host = uri.getHost();
        if (host == null || host.isBlank()) {
            return false;
        }
        String h = host.toLowerCase();
        for (String suffix : allowedSuffixes) {
            // 允许等于后缀本身，也允许是它的子域
            if (h.equals(suffix) || h.endsWith("." + suffix)) {
                return true;
            }
        }
        return false;
    }

    /** 校验失败时抛异常，用于调用点直接 fail-fast */
    public void assertAllowed(String url, String what) {
        if (!isAllowed(url)) {
            String host;
            try {
                host = URI.create(url == null ? "" : url.trim()).getHost();
            } catch (Exception e) {
                host = "(无法解析)";
            }
            throw new BaiduPanException("拒绝访问%s：主机 %s 不在白名单内".formatted(what, host), null);
        }
    }
}

package com.zcode.picman.web;

import com.zcode.picman.baidu.BaiduDtos.FsEntry;
import com.zcode.picman.baidu.BaiduDtos.Uinfo;
import com.zcode.picman.baidu.BaiduPanClient;
import com.zcode.picman.baidu.BaiduPanException;
import com.zcode.picman.baidu.BaiduPanProperties;
import com.zcode.picman.baidu.BaiduTokenStore;
import com.zcode.picman.config.AppProperties;
import com.zcode.picman.service.BaiduDiagnoseService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/baidu")
public class BaiduController {

    private static final Logger log = LoggerFactory.getLogger(BaiduController.class);

    private final BaiduTokenStore tokens;
    private final BaiduPanClient baidu;
    private final BaiduPanProperties baiduProps;
    private final BaiduDiagnoseService diagnose;
    private final AppProperties appProps;

    public BaiduController(BaiduTokenStore tokens, BaiduPanClient baidu, BaiduPanProperties baiduProps,
                           BaiduDiagnoseService diagnose, AppProperties appProps) {
        this.tokens = tokens;
        this.baidu = baidu;
        this.baiduProps = baiduProps;
        this.diagnose = diagnose;
        this.appProps = appProps;
    }

    public record StatusResponse(
            boolean configured,
            boolean authorized,
            String expiresAt,
            String scope,
            String accountName,
            String uk,
            String baseDir
    ) {
    }

    public record AuthorizeUrlResponse(String url) {
    }

    public record TokenRequest(@NotBlank(message = "授权码不能为空") String code) {
    }

    public record BrowseEntry(String path, String name, boolean isdir, long size) {
    }

    public record BrowseResponse(String dir, List<BrowseEntry> entries) {
    }

    @GetMapping("/status")
    public StatusResponse status() {
        var st = tokens.status();
        String accountName = null;
        String uk = null;
        if (st.authorized()) {
            // 账号名只是为了展示，取不到也不能让整个状态接口失败
            try {
                Uinfo u = baidu.uinfo();
                // netdisk_name 才是网盘昵称，baidu_name 是登录名（往往是手机号/数字 ID）
                accountName = u.netdiskName() != null && !u.netdiskName().isBlank()
                        ? u.netdiskName()
                        : u.baiduName();
                uk = u.uk() == null ? null : String.valueOf(u.uk());
            } catch (BaiduPanException e) {
                log.debug("获取百度账号信息失败：{}", e.getMessage());
            }
        }
        return new StatusResponse(
                baiduProps.isConfigured(),
                st.authorized(),
                st.expiresAt() == null ? null : st.expiresAt().toString(),
                st.scope(),
                accountName,
                uk,
                appProps.baseDir());
    }

    @GetMapping("/authorize-url")
    public AuthorizeUrlResponse authorizeUrl() {
        return new AuthorizeUrlResponse(tokens.authorizeUrl());
    }

    @PostMapping("/token")
    public StatusResponse exchange(@Valid @RequestBody TokenRequest request) {
        tokens.exchangeCode(request.code());
        return status();
    }

    @PostMapping("/refresh")
    public StatusResponse refresh() {
        tokens.forceRefresh();
        return status();
    }

    @PostMapping("/disconnect")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void disconnect() {
        tokens.clear();
    }

    /**
     * 接口体检。deep=false 只做只读检查；deep=true 会真实走一遍写入流程（自动清理临时文件）。
     */
    @PostMapping("/diagnose")
    public BaiduDiagnoseService.Report diagnose(@RequestParam(name = "deep", defaultValue = "false") boolean deep) {
        return diagnose.diagnose(deep);
    }

    @GetMapping("/quota")
    public Map<String, Object> quota() {
        return diagnose.quotaInfo();
    }

    /** 列网盘目录，供前端挑选基础目录 */
    @GetMapping("/browse")
    public BrowseResponse browse(@RequestParam(name = "dir", defaultValue = "/") String dir) {
        List<FsEntry> entries = baidu.listAll(dir);
        List<BrowseEntry> out = entries.stream()
                .map(e -> new BrowseEntry(
                        e.path(),
                        e.name(),
                        e.isDir(),
                        e.size() == null ? 0L : e.size()))
                .toList();
        return new BrowseResponse(dir, out);
    }

    /** 仅用于排查时对时间，不暴露任何密钥 */
    @GetMapping("/server-time")
    public Map<String, String> serverTime() {
        return Map.of("now", Instant.now().toString());
    }
}

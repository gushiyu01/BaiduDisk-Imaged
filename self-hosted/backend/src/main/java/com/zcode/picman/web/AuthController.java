package com.zcode.picman.web;

import com.zcode.picman.config.AppProperties;
import com.zcode.picman.security.JwtCookieFilter;
import com.zcode.picman.security.JwtService;
import com.zcode.picman.service.AuthService;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AuthService auth;
    private final JwtService jwt;
    private final AppProperties props;

    public AuthController(AuthService auth, JwtService jwt, AppProperties props) {
        this.auth = auth;
        this.jwt = jwt;
        this.props = props;
    }

    public record LoginRequest(@NotBlank String username, @NotBlank String password) {
    }

    public record MeResponse(String username) {
    }

    @PostMapping("/login")
    public MeResponse login(@Valid @RequestBody LoginRequest request, HttpServletResponse response) {
        String token = auth.login(request.username(), request.password());
        setCookie(response, token, jwt.sessionSeconds());
        return new MeResponse(request.username().trim());
    }

    @PostMapping("/logout")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void logout(HttpServletResponse response) {
        setCookie(response, "", 0);
    }

    @GetMapping("/me")
    public MeResponse me(Authentication authentication) {
        return new MeResponse(authentication.getName());
    }

    public record ChangePasswordRequest(@NotBlank String oldPassword, @NotBlank String newPassword) {
    }

    @PostMapping("/password")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void changePassword(Authentication authentication, @Valid @RequestBody ChangePasswordRequest request) {
        auth.changePassword(authentication.getName(), request.oldPassword(), request.newPassword());
    }

    /**
     * 会话令牌只放 HttpOnly Cookie：前端 JS 读不到，也就不存在被 XSS 偷走的问题。
     * SameSite=Lax 让跨站发起的表单提交带不上 Cookie，等于顺手拿到了 CSRF 防护。
     */
    private void setCookie(HttpServletResponse response, String value, long maxAgeSeconds) {
        Cookie cookie = new Cookie(JwtCookieFilter.COOKIE_NAME, value);
        cookie.setHttpOnly(true);
        cookie.setSecure(props.cookieSecure());
        cookie.setPath("/");
        cookie.setMaxAge((int) maxAgeSeconds);
        cookie.setAttribute("SameSite", "Lax");
        response.addCookie(cookie);
    }

    /** 便于前端在错误时展示更多上下文 */
    @GetMapping("/ping")
    public Map<String, Object> ping() {
        return Map.of("ok", true);
    }
}

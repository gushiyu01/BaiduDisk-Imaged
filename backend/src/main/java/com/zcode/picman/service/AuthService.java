package com.zcode.picman.service;

import com.zcode.picman.security.JwtService;
import com.zcode.picman.support.ApiException;
import com.zcode.picman.repository.UserRepository;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

import java.util.regex.Pattern;

@Service
public class AuthService {

    private static final int MIN_PASSWORD_LENGTH = 8;
    private static final Pattern USERNAME = Pattern.compile("^[A-Za-z0-9_.-]{3,32}$");

    private final UserRepository users;
    private final PasswordEncoder encoder;
    private final JwtService jwt;

    public AuthService(UserRepository users, PasswordEncoder encoder, JwtService jwt) {
        this.users = users;
        this.encoder = encoder;
        this.jwt = jwt;
    }

    public boolean isInitialized() {
        return users.count() > 0;
    }

    /**
     * 首次启动创建管理员。只允许在没有任何账号时调用，
     * 且密码由使用者自己设定——不提供任何内置默认口令。
     */
    public String initialize(String username, String password) {
        if (isInitialized()) {
            throw ApiException.conflict("系统已完成初始化，不能再创建管理员");
        }
        validate(username, password);
        users.insert(username, encoder.encode(password));
        return username;
    }

    /** 校验通过返回会话令牌 */
    public String login(String username, String password) {
        if (!isInitialized()) {
            throw new ApiException(org.springframework.http.HttpStatus.CONFLICT,
                    "NOT_INITIALIZED", "系统尚未初始化，请先创建管理员账号");
        }
        var user = users.findByUsername(username == null ? "" : username.trim())
                .orElseThrow(() -> new ApiException(org.springframework.http.HttpStatus.UNAUTHORIZED,
                        "BAD_CREDENTIALS", "用户名或密码错误"));
        if (!encoder.matches(password == null ? "" : password, user.passwordHash())) {
            throw new ApiException(org.springframework.http.HttpStatus.UNAUTHORIZED,
                    "BAD_CREDENTIALS", "用户名或密码错误");
        }
        return jwt.issue(user.username());
    }

    public void changePassword(String username, String oldPassword, String newPassword) {
        var user = users.findByUsername(username)
                .orElseThrow(() -> ApiException.notFound("用户不存在"));
        if (!encoder.matches(oldPassword == null ? "" : oldPassword, user.passwordHash())) {
            throw new ApiException(org.springframework.http.HttpStatus.UNAUTHORIZED,
                    "BAD_CREDENTIALS", "原密码不正确");
        }
        if (newPassword == null || newPassword.length() < MIN_PASSWORD_LENGTH) {
            throw ApiException.badRequest("新密码至少 %d 位".formatted(MIN_PASSWORD_LENGTH));
        }
        if (newPassword.matches("^\\d+$")) {
            throw ApiException.badRequest("新密码不能是纯数字");
        }
        users.updatePassword(username, encoder.encode(newPassword));
    }

    private void validate(String username, String password) {
        if (username == null || !USERNAME.matcher(username.trim()).matches()) {
            throw ApiException.badRequest("用户名需为 3-32 位的字母、数字、下划线、点或短横线");
        }
        if (password == null || password.length() < MIN_PASSWORD_LENGTH) {
            throw ApiException.badRequest("密码至少 %d 位".formatted(MIN_PASSWORD_LENGTH));
        }
        if (password.matches("^\\d+$")) {
            throw ApiException.badRequest("密码不能是纯数字");
        }
    }
}

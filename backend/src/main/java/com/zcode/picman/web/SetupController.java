package com.zcode.picman.web;

import com.zcode.picman.service.AuthService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/setup")
public class SetupController {

    private final AuthService auth;

    public SetupController(AuthService auth) {
        this.auth = auth;
    }

    public record StatusResponse(boolean initialized) {
    }

    public record InitRequest(@NotBlank(message = "用户名不能为空") String username,
                              @NotBlank(message = "密码不能为空") String password) {
    }

    public record InitResponse(String username) {
    }

    @GetMapping("/status")
    public StatusResponse status() {
        return new StatusResponse(auth.isInitialized());
    }

    /** 只在还没有任何管理员账号时可调用；密码由使用者自己定，系统不提供默认口令 */
    @PostMapping("/init")
    public InitResponse init(@Valid @RequestBody InitRequest request) {
        String username = auth.initialize(request.username(), request.password());
        return new InitResponse(username);
    }
}

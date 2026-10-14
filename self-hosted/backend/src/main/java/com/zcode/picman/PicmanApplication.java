package com.zcode.picman;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.security.servlet.UserDetailsServiceAutoConfiguration;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * 排除 UserDetailsServiceAutoConfiguration：本项目的登录是自己实现的，
 * 不排除的话 Spring Boot 每次启动都会生成一个用不上的内存用户并打印随机密码，纯噪音。
 */
@SpringBootApplication(exclude = UserDetailsServiceAutoConfiguration.class)
@ConfigurationPropertiesScan
public class PicmanApplication {

    public static void main(String[] args) {
        SpringApplication.run(PicmanApplication.class, args);
    }
}

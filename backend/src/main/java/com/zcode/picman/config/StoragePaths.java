package com.zcode.picman.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.BeansException;
import org.springframework.beans.factory.config.BeanFactoryPostProcessor;
import org.springframework.beans.factory.config.ConfigurableListableBeanFactory;
import org.springframework.context.EnvironmentAware;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 建库建缓存目录。
 * <p>
 * 必须做成 BeanFactoryPostProcessor：SQLite 的 DataSource 在文件所在目录不存在时
 * 直接启动失败，所以目录必须在 DataSource 被创建之前就准备好。
 */
@Component
public class StoragePaths implements BeanFactoryPostProcessor, EnvironmentAware {

    private static final Logger log = LoggerFactory.getLogger(StoragePaths.class);

    private Environment env;

    @Override
    public void setEnvironment(Environment environment) {
        this.env = environment;
    }

    @Override
    public void postProcessBeanFactory(ConfigurableListableBeanFactory beanFactory) throws BeansException {
        Path cacheDir = Path.of(env.getProperty("PICMAN_CACHE_DIR", "./data/cache")).toAbsolutePath();
        mkdirs(cacheDir, "缓存目录");
        mkdirs(cacheDir.resolve("thumbs"), "缩略图缓存目录");
        log.info("缓存目录：{}", cacheDir);

        // 走 MySQL 时数据库不在本地文件系统上，没有目录要建；
        // 这时还去建 PICMAN_DB_PATH 的父目录只会徒增一个误导性的空目录
        boolean usingMySql = java.util.Arrays.asList(env.getActiveProfiles()).contains("mysql");
        if (usingMySql) {
            log.info("数据库：MySQL（配置档 mysql）");
            return;
        }

        Path dbPath = Path.of(env.getProperty("PICMAN_DB_PATH", "./data/picman.db")).toAbsolutePath();
        mkdirs(dbPath.getParent(), "数据库目录");
        log.info("数据库文件：{}", dbPath);
    }

    private static void mkdirs(Path dir, String what) {
        if (dir == null) {
            return;
        }
        try {
            Files.createDirectories(dir);
        } catch (IOException e) {
            throw new IllegalStateException("无法创建%s %s：%s".formatted(what, dir, e.getMessage()), e);
        }
    }
}

package com.zcode.picman.service;

import com.zcode.picman.baidu.BaiduDtos.FileMeta;
import com.zcode.picman.baidu.BaiduDtos.FsEntry;
import com.zcode.picman.baidu.BaiduPanClient;
import com.zcode.picman.baidu.BaiduPanException;
import com.zcode.picman.config.AppProperties;
import com.zcode.picman.repository.AssetRepository;
import com.zcode.picman.support.MimeTypes;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * 把网盘目录下的图片同步进本地索引。
 * <p>
 * 只做「网盘 → 索引」这一个方向；收藏和标签是纯本地数据，同步过程绝不覆盖。
 */
@Service
public class SyncService {

    private static final Logger log = LoggerFactory.getLogger(SyncService.class);

    /** filemetas 单次上限 100 */
    private static final int META_BATCH = 100;

    private final AppProperties props;
    private final AssetRepository assets;
    private final AssetService assetService;
    private final BaiduPanClient baidu;

    public SyncService(AppProperties props, AssetRepository assets, AssetService assetService, BaiduPanClient baidu) {
        this.props = props;
        this.assets = assets;
        this.assetService = assetService;
        this.baidu = baidu;
    }

    public record SyncResult(int scanned, int added, int updated, int removed, int failed, long elapsedMs) {
    }

    public SyncResult sync(String dirOverride) {
        long started = System.currentTimeMillis();
        String baseDir = (dirOverride == null || dirOverride.isBlank()) ? props.baseDir() : dirOverride.trim();

        // 目录不存在时先建出来，否则第一次同步必然报 -9
        baidu.mkdir(baseDir);

        List<FsEntry> all = baidu.listRecursive(baseDir);
        // 索引目录下所有文件，不再只挑图片 —— 图片只是 kind='IMAGE' 的一种
        List<FsEntry> fileEntries = all.stream()
                .filter(e -> !e.isDir())
                .toList();

        // 宽高和缩略图只有 filemetas 给，按批补齐
        Map<String, FileMeta> metaByPath = new HashMap<>();
        int failed = 0;
        List<Long> fsIds = fileEntries.stream()
                .map(FsEntry::fsId)
                .filter(Objects::nonNull)
                .toList();
        for (int i = 0; i < fsIds.size(); i += META_BATCH) {
            List<Long> batch = fsIds.subList(i, Math.min(i + META_BATCH, fsIds.size()));
            try {
                for (FileMeta meta : baidu.fileMetas(batch, false, true, true)) {
                    if (meta.path() != null) {
                        metaByPath.put(meta.path(), meta);
                    }
                }
            } catch (BaiduPanException e) {
                // 单批失败不中断整体同步，但要如实计入 failed
                failed += batch.size();
                log.warn("批量查询元数据失败（{} 个，从索引 {} 开始）：{}", batch.size(), i, e.getMessage());
            }
        }

        Set<String> existingPaths = new LinkedHashSet<>(assets.findPathsUnder(baseDir));
        Set<String> remotePaths = new HashSet<>();
        int added = 0;
        int updated = 0;
        for (FsEntry entry : fileEntries) {
            remotePaths.add(entry.path());
            if (existingPaths.contains(entry.path())) {
                updated++;
            } else {
                added++;
            }
        }

        assetService.upsertEntries(fileEntries, metaByPath);

        // 索引里有、网盘上没有的，标记为已丢失而不是直接删记录
        List<String> gone = new ArrayList<>();
        for (String path : existingPaths) {
            if (!remotePaths.contains(path)) {
                gone.add(path);
            }
        }
        if (!gone.isEmpty()) {
            assets.setMissingByPath(gone, true);
        }

        long elapsed = System.currentTimeMillis() - started;
        SyncResult result = new SyncResult(fileEntries.size(), added, updated, gone.size(), failed, elapsed);
        log.info("同步完成：{}", result);
        return result;
    }
}

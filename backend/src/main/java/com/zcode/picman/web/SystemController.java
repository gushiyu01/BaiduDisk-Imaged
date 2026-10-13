package com.zcode.picman.web;

import com.zcode.picman.config.AppProperties;
import com.zcode.picman.repository.AssetRepository;
import com.zcode.picman.repository.TagRepository;
import com.zcode.picman.service.ThumbnailService;
import com.zcode.picman.support.FileKinds;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/system")
public class SystemController {

    private final AppProperties props;
    private final AssetRepository assets;
    private final TagRepository tags;
    private final ThumbnailService thumbnails;

    public SystemController(AppProperties props, AssetRepository assets, TagRepository tags,
                            ThumbnailService thumbnails) {
        this.props = props;
        this.assets = assets;
        this.tags = tags;
        this.thumbnails = thumbnails;
    }

    @GetMapping("/info")
    public Map<String, Object> info() {
        Map<String, Long> counts = assets.countsByKind();
        // 每种类型都补上 0，前端不用做「键不存在」的判断
        Map<String, Long> kinds = new LinkedHashMap<>();
        for (String kind : FileKinds.ALL) {
            kinds.put(kind, counts.getOrDefault(kind, 0L));
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("version", "1.0.0");
        out.put("baseDir", props.baseDir());
        out.put("cacheDir", Path.of(props.cacheDir()).toAbsolutePath().toString());
        out.put("cacheSizeBytes", thumbnails.cacheSizeBytes());
        out.put("dbPath", Path.of(props.dbPath()).toAbsolutePath().toString());
        // assetCount 是全部文件；imageCount 保留，等于 kind=IMAGE 的数量，老前端不用改
        out.put("assetCount", assets.count());
        out.put("imageCount", kinds.get(FileKinds.IMAGE));
        out.put("kindCounts", kinds);
        out.put("tagCount", tags.findAllWithCount().size());
        return out;
    }

    /** 清空缩略图缓存。下次访问会按需重新生成（官方缩略图优先）。 */
    @PostMapping("/cache/clear")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void clearCache() {
        thumbnails.clearCache();
    }
}

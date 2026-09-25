#include <linux/bpf.h>
#include <linux/if_ether.h>
#include <linux/ip.h>
#include <linux/tcp.h>
#include <linux/in.h>

#define SEC(NAME) __attribute__((section(NAME), used))
#define NS_PER_SECOND 1000000000ULL
#define TTTPS_8443 0
#define TTTPS_8090 1

struct bpf_map_def {
    __u32 type;
    __u32 key_size;
    __u32 value_size;
    __u32 max_entries;
};

struct port_bucket {
    __u64 window_start_ns;
    __u32 packets;
    __u32 drops;
};

struct bpf_map_def SEC("maps") limits = {
    .type = BPF_MAP_TYPE_ARRAY,
    .key_size = sizeof(__u32),
    .value_size = sizeof(__u32),
    .max_entries = 2,
};

struct bpf_map_def SEC("maps") buckets = {
    .type = BPF_MAP_TYPE_ARRAY,
    .key_size = sizeof(__u32),
    .value_size = sizeof(struct port_bucket),
    .max_entries = 2,
};

static void *(*map_lookup_elem)(void *map, const void *key) = (void *)1;
static __u64 (*ktime_get_ns)(void) = (void *)5;

static __always_inline int rate_limit(__u32 key)
{
    __u64 now = ktime_get_ns();
    __u32 default_limit = key == TTTPS_8443 ? 20000 : 5000;
    __u32 *configured = map_lookup_elem(&limits, &key);
    __u32 limit = configured ? *configured : default_limit;
    struct port_bucket *bucket = map_lookup_elem(&buckets, &key);

    if (!bucket)
        return XDP_PASS;
    if (bucket->window_start_ns == 0 ||
        now - bucket->window_start_ns >= NS_PER_SECOND) {
        bucket->window_start_ns = now;
        bucket->packets = 0;
    }
    if (bucket->packets >= limit) {
        bucket->drops++;
        return XDP_DROP;
    }
    bucket->packets++;
    return XDP_PASS;
}

SEC("xdp")
int tttps_xdp(struct xdp_md *ctx)
{
    void *data = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;
    struct ethhdr *eth = data;
    struct iphdr *ip;
    struct tcphdr *tcp;
    __u32 key;

    if ((void *)(eth + 1) > data_end || eth->h_proto != __constant_htons(ETH_P_IP))
        return XDP_PASS;
    ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end || ip->protocol != IPPROTO_TCP)
        return XDP_PASS;
    if (ip->ihl < 5 || (void *)ip + ip->ihl * 4 > data_end)
        return XDP_PASS;
    tcp = (void *)ip + ip->ihl * 4;
    if ((void *)(tcp + 1) > data_end)
        return XDP_PASS;

    if (tcp->dest == __constant_htons(8443))
        key = TTTPS_8443;
    else if (tcp->dest == __constant_htons(8090))
        key = TTTPS_8090;
    else
        return XDP_PASS;
    return rate_limit(key);
}

char LICENSE[] SEC("license") = "GPL";

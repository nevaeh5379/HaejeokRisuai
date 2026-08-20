<script lang="ts">
    import MainMenu from './MainMenu.svelte'
    import SideBarArrow from './GUI/SideBarArrow.svelte'
</script>

<div class="grow h-full min-w-0 relative justify-center flex">
    <SideBarArrow />
    <div class="h-full w-full">
        <MainMenu />
    </div>
</div>
